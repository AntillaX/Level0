// Mafia — social deduction.
//
// Designed for friends on a voice call (Discord etc.) using their
// phones as the moderator. The site assigns hidden roles, runs the
// night actions privately, and resolves day votes — the actual
// "discussion" is the voice call.
//
// Roles (v1): mafia, detective, civilian.
//
// Phases:
//   reveal  — each player taps to see their role. Auto-advances
//             once everyone has acked.
//   night   — mafia pick a target (each mafia votes; majority kills);
//             detective investigates one player and gets a yes/no.
//             Civilians wait. Auto-advances when night actions done.
//   day     — last night's death is announced. Alive players vote
//             on who to eliminate. Auto-advances when all alive have
//             voted (a "skip" vote is allowed for the indecisive).
//             The most-voted player is eliminated; ties → no
//             elimination. Win check after each day. Loop to night.
//   finished — winners declared, all roles revealed.
//
// Win conditions:
//   civilians win when zero mafia are alive
//   mafia win when mafia ≥ non-mafia alive (parity rule)
//
// Per-viewer state: each connected occupant gets a *different*
// snapshot. Mafia see their teammates and the night vote tally;
// detective sees their investigation result; eliminated players
// and spectators see the full picture; living civilians see only
// the public record. All filtering goes through viewFor(viewer).

const ROLES = ['mafia', 'detective', 'civilian'];

function roleCounts(n) {
  // Standard distribution. Mafia roughly 1/3 of players, min 1; one
  // detective; rest are civilians.
  const mafia = n <= 6 ? 1 : n <= 9 ? 2 : 3;
  const detective = 1;
  const civilian = n - mafia - detective;
  return { mafia, detective, civilian };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class Mafia {
  constructor(players, broadcast, onEnd, opts = {}) {
    this.players = players;
    this.broadcast = broadcast;            // legacy: same payload to everyone
    this.broadcastPerViewer = opts.broadcastPerViewer; // per-viewer payloads
    this.onEnd = onEnd;

    this.order = players.map((p) => p.id);
    this.roles = {};                       // { id: 'mafia' | 'detective' | 'civilian' }
    this.alive = {};                       // { id: bool }
    this.revealed = new Set();             // playerIds who acked their role
    this.eliminations = [];                // [{ round, phase, targetId, role, by }]

    const prevWins = opts.wins || {};
    this.wins = {};
    for (const p of players) this.wins[p.id] = prevWins[p.id] || 0;

    this.phase = 'reveal';
    this.round = 1;

    this.mafiaVotes = {};                  // night: { mafiaId: targetId }
    this.detectiveTarget = null;
    this.detectiveResult = null;           // { targetId, isMafia }
    this.lastNightKill = null;             // { targetId, role } shown on day

    this.dayVotes = {};                    // { voterId: targetId | 'skip' }
    this.dayResolving = false;             // true during the 3.5s pause
                                           // after a vote resolves, blocks
                                           // re-resolution from late changes

    this.status = 'playing';
    this.result = null;
  }

  start() {
    this.phase = 'reveal';
    this.round = 1;
    this.eliminations = [];
    this.mafiaVotes = {};
    this.detectiveTarget = null;
    this.detectiveResult = null;
    this.lastNightKill = null;
    this.dayVotes = {};
    this.dayResolving = false;
    this.gameEnding = false;
    this.endGameTimer = null;
    this.revealed = new Set();
    this.status = 'playing';
    this.result = null;

    this.assignRoles();

    // Initial broadcast (per-viewer so each player sees only their
    // own role at this stage).
    this.broadcastState({ kind: 'game_started' });
  }

  assignRoles() {
    const n = this.players.length;
    const counts = roleCounts(n);
    const roleBag = [
      ...Array(counts.mafia).fill('mafia'),
      ...Array(counts.detective).fill('detective'),
      ...Array(counts.civilian).fill('civilian'),
    ];
    const shuffled = shuffle(roleBag);
    for (let i = 0; i < this.players.length; i++) {
      this.roles[this.players[i].id] = shuffled[i];
      this.alive[this.players[i].id] = true;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────

  aliveIds() {
    return this.order.filter((id) => this.alive[id]);
  }

  aliveByRole(role) {
    return this.aliveIds().filter((id) => this.roles[id] === role);
  }

  isMafia(id) { return this.roles[id] === 'mafia'; }
  isDetective(id) { return this.roles[id] === 'detective'; }

  // ── Action handler ───────────────────────────────────────────────

  handleAction(playerId, action) {
    if (!action) return { success: false, error: 'No action' };
    if (this.status !== 'playing') return { success: false, error: 'Game is over' };

    switch (action.kind) {
      case 'reveal_ack':       return this.actReveal(playerId);
      case 'mafia_vote':       return this.actMafiaVote(playerId, action.targetId);
      case 'investigate':      return this.actInvestigate(playerId, action.targetId);
      case 'day_vote':         return this.actDayVote(playerId, action.targetId);
      default: return { success: false, error: 'Unknown action' };
    }
  }

  actReveal(playerId) {
    if (this.phase !== 'reveal') return { success: false, error: 'Not in reveal phase' };
    if (!this.roles[playerId]) return { success: false, error: 'You are not in this game' };
    this.revealed.add(playerId);
    if (this.revealed.size >= this.players.length) {
      // Last player just acked. Don't start night immediately —
      // they need a beat to actually read their own role on the
      // freshly flipped card. The progress broadcast still fires
      // so other clients see "5/5 ready".
      this.broadcastState({ kind: 'reveal_progress' });
      if (this.startNightTimer) clearTimeout(this.startNightTimer);
      this.startNightTimer = setTimeout(() => {
        this.startNightTimer = null;
        this.startNight();
      }, 2500);
    } else {
      this.broadcastState({ kind: 'reveal_progress' });
    }
    return { success: true };
  }

  actMafiaVote(playerId, targetId) {
    if (this.phase !== 'night') return { success: false, error: 'Not night' };
    if (this.gameEnding) return { success: false, error: 'Game is ending' };
    if (!this.alive[playerId] || !this.isMafia(playerId)) {
      return { success: false, error: 'Only living mafia may vote at night' };
    }
    if (!this.alive[targetId] || this.isMafia(targetId)) {
      return { success: false, error: 'Pick a living non-mafia target' };
    }
    this.mafiaVotes[playerId] = targetId;
    // Broadcast first so all mafia see the running tally update,
    // then resolve. If this vote was the last one needed, the
    // resolver will broadcast its own day_started afterwards.
    this.broadcastState({ kind: 'mafia_voted' });
    this.maybeResolveNight();
    return { success: true };
  }

  actInvestigate(playerId, targetId) {
    if (this.phase !== 'night') return { success: false, error: 'Not night' };
    if (this.gameEnding) return { success: false, error: 'Game is ending' };
    if (!this.alive[playerId] || !this.isDetective(playerId)) {
      return { success: false, error: 'Only the living detective may investigate' };
    }
    if (this.detectiveTarget) {
      return { success: false, error: 'Already investigated this round' };
    }
    if (!this.alive[targetId] || targetId === playerId) {
      return { success: false, error: 'Pick a living target other than yourself' };
    }
    this.detectiveTarget = targetId;
    this.detectiveResult = { round: this.round, targetId, isMafia: this.isMafia(targetId) };
    // Broadcast the result to the detective *before* resolving the
    // night. Otherwise, if this investigation was the last pending
    // night action, the next broadcast is day_started — and that
    // doesn't include detectiveResult, so the detective never
    // sees what they found out.
    this.broadcastState({ kind: 'detective_done' });
    this.maybeResolveNight();
    return { success: true };
  }

  actDayVote(playerId, targetId) {
    if (this.phase !== 'day') return { success: false, error: 'Not day' };
    // Once the vote has resolved and we're in the brief pause before
    // night, votes are locked — otherwise a late change could
    // re-trigger maybeResolveDay and re-eliminate someone. Same for
    // the post-resolve pause when the game is about to end.
    if (this.dayResolving) return { success: false, error: 'Vote already resolved' };
    if (this.gameEnding) return { success: false, error: 'Game is ending' };
    if (!this.alive[playerId]) return { success: false, error: 'Eliminated players cannot vote' };
    if (targetId !== 'skip') {
      if (!this.alive[targetId] || targetId === playerId) {
        return { success: false, error: 'Pick a living target other than yourself' };
      }
    }
    this.dayVotes[playerId] = targetId;
    this.broadcastState({ kind: 'day_voted' });
    this.maybeResolveDay();
    return { success: true };
  }

  // ── Phase resolution ─────────────────────────────────────────────

  startNight() {
    this.phase = 'night';
    this.mafiaVotes = {};
    this.detectiveTarget = null;
    // detectiveResult is intentionally NOT cleared here — the
    // detective remembers their last investigation across phases
    // until they make a new one. The client decides whether to show
    // the result or the investigate UI based on the result's
    // .round vs the current round.
    this.dayResolving = false;
    this.broadcastState({ kind: 'night_started' });
  }

  maybeResolveNight() {
    const aliveMafia = this.aliveByRole('mafia');
    const aliveDetective = this.aliveByRole('detective');
    const allMafiaVoted = aliveMafia.every((id) => this.mafiaVotes[id]);
    const detectiveDone = aliveDetective.length === 0 || this.detectiveTarget !== null;
    if (!allMafiaVoted || !detectiveDone) return;

    // Tally mafia votes; pick the most-voted target (random tiebreak).
    const tally = {};
    for (const id of aliveMafia) {
      const t = this.mafiaVotes[id];
      tally[t] = (tally[t] || 0) + 1;
    }
    const top = Math.max(...Object.values(tally));
    const candidates = Object.keys(tally).filter((id) => tally[id] === top);
    const killId = candidates[Math.floor(Math.random() * candidates.length)];

    this.alive[killId] = false;
    this.lastNightKill = { targetId: killId, role: this.roles[killId] };
    this.eliminations.push({
      round: this.round, phase: 'night',
      targetId: killId, role: this.roles[killId], by: 'mafia',
    });

    // Always transition to day so the kill is announced — even if a
    // win has just been triggered. The day phase shows
    // "X was killed last night — they were a [role]". scheduleEndGame
    // gives the table a beat to read it before flipping to gameover.
    this.startDay();
    const winner = this.checkWin();
    if (winner) this.scheduleEndGame(winner);
  }

  startDay() {
    this.phase = 'day';
    this.dayVotes = {};
    this.broadcastState({ kind: 'day_started' });
  }

  maybeResolveDay() {
    if (this.dayResolving) return;
    const alive = this.aliveIds();
    const allVoted = alive.every((id) => this.dayVotes[id] !== undefined);
    if (!allVoted) return;
    this.dayResolving = true;

    // Tally non-skip votes.
    const tally = {};
    for (const id of alive) {
      const v = this.dayVotes[id];
      if (v === 'skip') continue;
      tally[v] = (tally[v] || 0) + 1;
    }

    let elimId = null;
    if (Object.keys(tally).length > 0) {
      const top = Math.max(...Object.values(tally));
      const candidates = Object.keys(tally).filter((id) => tally[id] === top);
      // Tie → no elimination (a deliberate, common house rule).
      if (candidates.length === 1) elimId = candidates[0];
    }

    if (elimId) {
      this.alive[elimId] = false;
      this.eliminations.push({
        round: this.round, phase: 'day',
        targetId: elimId, role: this.roles[elimId], by: 'town',
      });
    }
    // Snapshot the day outcome — the elimination (if any) is already
    // recorded in eliminations[] for the current round, which the
    // client uses to show "X was eliminated — they were a [role]"
    // for the duration of this day phase before we flip to night.
    this.broadcastState({ kind: 'day_resolved' });

    const winner = this.checkWin();
    if (winner) {
      // Hold on the day_resolved banner, then end. (Without the pause,
      // clients only see the banner for ~400ms before the gameover
      // screen replaces it — too fast to follow.)
      this.scheduleEndGame(winner);
      return;
    }

    // Delay before the next night so the table has time to absorb
    // the elimination on screen. (Cleared if the room is destroyed
    // mid-pause.)
    if (this.dayResolveTimer) clearTimeout(this.dayResolveTimer);
    this.dayResolveTimer = setTimeout(() => {
      this.dayResolveTimer = null;
      this.round += 1;
      this.startNight();
    }, 3500);
  }

  // Returns 'civilians' | 'mafia' | null — pure check, no side effects.
  checkWin() {
    const aliveMafia = this.aliveByRole('mafia').length;
    const aliveOther = this.aliveIds().length - aliveMafia;
    if (aliveMafia === 0) return 'civilians';
    if (aliveMafia >= aliveOther) return 'mafia';
    return null;
  }

  // Schedule the game to end after a 2.5s pause, so clients can see
  // the last action (day_resolved banner or day_started kill banner)
  // before transitioning to the gameover screen. While the pause is
  // running, votes are locked via this.gameEnding so a stray late
  // input can't double-eliminate or change the outcome.
  scheduleEndGame(winner) {
    if (this.endGameTimer) return;
    this.gameEnding = true;
    this.endGameTimer = setTimeout(() => {
      this.endGameTimer = null;
      this.endGame(winner);
    }, 2500);
  }

  endGame(winner) {
    if (this.status === 'finished') return;
    this.status = 'finished';
    // Crucial: setting this.phase ='finished' (not just status) is
    // what makes viewFor's showAll branch fire for *every* viewer,
    // so visibleRoles contains all roles in the gameover broadcast.
    // Without this, alive non-spectator players only saw their own
    // role + mafia teammates + dead players — the rest displayed
    // as "?" on the gameover screen.
    this.phase = 'finished';
    this.result = { kind: 'win', winner };

    // Increment the cross-round win tally for everyone on the winning
    // side. Useful so a single Room can rotate roles across rounds.
    for (const id of this.order) {
      const onWinningSide = winner === 'mafia'
        ? this.roles[id] === 'mafia'
        : this.roles[id] !== 'mafia';
      if (onWinningSide) this.wins[id] = (this.wins[id] || 0) + 1;
    }

    this.broadcastState({ kind: 'game_over' });
    if (this.onEnd) this.onEnd();
  }

  // ── State broadcast ──────────────────────────────────────────────

  // Build a per-viewer snapshot for one occupant. The server's
  // broadcastPerViewer wraps this with the room state. The wrapper
  // around `kind` lets each broadcast carry a top-level `type` so
  // the client can do simple message routing.
  broadcastState(topInfo) {
    if (!this.broadcastPerViewer) {
      // Fallback: room state only, public view (no per-player private
      // info). Should only happen if Room didn't pass the per-viewer
      // helper through, which would be a wiring bug.
      this.broadcast({ type: topInfo.kind || 'game_update', ...this.publicView() });
      return;
    }
    this.broadcastPerViewer((occ) => ({
      type: topInfo.kind || 'game_update',
      ...this.viewFor(occ),
    }));
  }

  publicView() {
    // Same as viewFor for a connected non-spectator with no role
    // (used only as a fallback). Returns sanitized info.
    return {
      gameType: 'mafia',
      phase: this.phase,
      round: this.round,
      alive: { ...this.alive },
      revealed: Array.from(this.revealed),
      eliminations: [...this.eliminations],
      status: this.status,
      result: this.result,
      wins: { ...this.wins },
      visibleRoles: this.phase === 'finished' ? { ...this.roles } : {},
    };
  }

  viewFor(occ) {
    const showAll = this.phase === 'finished'
      || occ.isSpectator
      || (this.roles[occ.id] && !this.alive[occ.id]); // eliminated player

    const view = {
      gameType: 'mafia',
      phase: this.phase,
      round: this.round,
      alive: { ...this.alive },
      revealed: Array.from(this.revealed),
      eliminations: [...this.eliminations],
      status: this.status,
      result: this.result,
      wins: { ...this.wins },
      lastNightKill: this.lastNightKill,
      myRole: this.roles[occ.id] || null,
    };

    // Visible roles map. Rules:
    //   - You always see your own role.
    //   - Mafia see their teammates.
    //   - Dead players' roles are public — death reveals the role.
    //   - Eliminated viewers, spectators, or any viewer once the
    //     game has finished, see everyone's role.
    const visibleRoles = {};
    if (showAll) {
      Object.assign(visibleRoles, this.roles);
    } else if (this.roles[occ.id]) {
      visibleRoles[occ.id] = this.roles[occ.id];
      if (this.roles[occ.id] === 'mafia') {
        for (const id of this.order) {
          if (this.roles[id] === 'mafia') visibleRoles[id] = 'mafia';
        }
      }
      for (const id of this.order) {
        if (!this.alive[id] && this.roles[id]) visibleRoles[id] = this.roles[id];
      }
    }
    view.visibleRoles = visibleRoles;

    // Night-only: mafia tally + detectiveTarget (used to gate
    // a second investigation in the same night).
    if (this.phase === 'night') {
      if (showAll || (this.alive[occ.id] && this.isMafia(occ.id))) {
        view.mafiaVotes = { ...this.mafiaVotes };
      }
      if (showAll || (this.alive[occ.id] && this.isDetective(occ.id))) {
        if (this.detectiveTarget) view.detectiveTarget = this.detectiveTarget;
      }
    }
    // Detective's investigation result persists across all phases
    // for the detective (or anyone with full visibility) so they
    // can refer back to it during the day discussion.
    if (this.detectiveResult && (showAll || (this.alive[occ.id] && this.isDetective(occ.id)))) {
      view.detectiveResult = this.detectiveResult;
    }

    // Day votes are public.
    if (this.phase === 'day') {
      view.dayVotes = { ...this.dayVotes };
    }

    return view;
  }

  // For Room.getFullState(viewerId) on reconnect / spectator join.
  // Room passes in the real occupant when it knows it; we fall back
  // to a synthetic one (treating roleless viewers as spectators) for
  // backwards compatibility with the older single-arg signature.
  getFullState(viewerId, occupant) {
    const occ = occupant || {
      id: viewerId,
      isSpectator: !this.roles[viewerId],
    };
    return this.viewFor(occ);
  }

  destroy() {
    if (this.dayResolveTimer) {
      clearTimeout(this.dayResolveTimer);
      this.dayResolveTimer = null;
    }
    if (this.endGameTimer) {
      clearTimeout(this.endGameTimer);
      this.endGameTimer = null;
    }
    if (this.startNightTimer) {
      clearTimeout(this.startNightTimer);
      this.startNightTimer = null;
    }
  }
}

module.exports = Mafia;
