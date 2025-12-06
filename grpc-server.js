// gRPC server for realtime drawing game communication
// Uses bidirectional streaming for realtime events

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const GameLogic = require('./game-logic');

const PROTO_PATH = path.join(__dirname, 'drawing-game.proto');

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
});

const proto = grpc.loadPackageDefinition(packageDefinition).drawinggame;

// Initialize game logic
const gameLogic = new GameLogic();

// Implement the Connect service method (bidirectional streaming)
function connect(call) {
    console.log('New gRPC connection established');

    // Generate a unique user ID for this connection
    const userId = uuidv4();
    call.metadata.set('userId', userId);

    // Handle incoming messages from client
    call.on('data', (gameEvent) => {
        try {
            const { room, join, segment, clear, cursor, wordSelect, gameStart, chatMessage } = gameEvent;

            // Handle different event types using object destructuring
            if (join) gameLogic.handleJoin(call, join);
            else if (segment) gameLogic.handleSegment(call, room, segment);
            else if (clear !== undefined) gameLogic.handleClear(call, room);
            else if (cursor) gameLogic.handleCursor(call, room, cursor);
            else if (wordSelect) gameLogic.handleWordSelect(call, room, wordSelect);
            else if (gameStart !== undefined) gameLogic.handleGameStart(call, room);
            else if (chatMessage) gameLogic.handleChatMessage(call, room, chatMessage);
        } catch (error) {
            console.error('Error handling game event:', error);
        }
    });

    // Handle connection end
    call.on('end', () => {
        console.log('gRPC connection ended');
        gameLogic.cleanup(call);
        call.end();
    });

    // Handle connection errors
    call.on('error', (error) => {
        console.error('gRPC connection error:', error);
        gameLogic.cleanup(call);
    });
}

// Create and start the gRPC server
function main() {
    const server = new grpc.Server();

    // Add the DrawingGameService
    server.addService(proto.DrawingGameService.service, {
        Connect: connect
    });

    const port = process.env.GRPC_PORT || 50051;
    const host = '0.0.0.0';

    server.bindAsync(`${host}:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
        if (err) {
            console.error('Failed to start gRPC server:', err);
            return;
        }

        console.log(`🚀 gRPC server running on ${host}:${boundPort}`);
        server.start();
    });
}

module.exports = main;
