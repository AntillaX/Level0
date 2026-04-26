class Player {
  constructor(id, name, ws, role = 'player', isBot = false) {
    this.id = id;
    this.name = name;
    this.ws = ws;
    this.role = role; // 'player' | 'spectator'
    this.isBot = isBot;
    this.connected = true; // bots stay "connected" indefinitely
  }

  get isSpectator() {
    return this.role === 'spectator';
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      role: this.role,
      isBot: this.isBot,
      connected: this.connected,
    };
  }
}

module.exports = Player;
