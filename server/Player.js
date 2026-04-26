class Player {
  constructor(id, name, ws, role = 'player') {
    this.id = id;
    this.name = name;
    this.ws = ws;
    this.role = role; // 'player' | 'spectator'
    this.connected = true;
  }

  get isSpectator() {
    return this.role === 'spectator';
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      role: this.role,
      connected: this.connected,
    };
  }
}

module.exports = Player;
