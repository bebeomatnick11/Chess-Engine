{
  "name": "oani-omega-chess",
  "version": "1.0.0",
  "private": true,
  "description": "OANI Omega Chess: independent chess engine with adaptive opponent memory",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "chess.js": "1.4.0",
    "express": "4.21.2",
    "pg": "8.13.1"
  }
}
