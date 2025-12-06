// Main entry point for the drawing game backend
// Starts the Socket.IO server for realtime communication

console.log('🎨 Starting Drawing Game Backend (Socket.IO)...');

// Import and run the Socket.IO server directly since it exports a server.listen call
require('./socket-server');
