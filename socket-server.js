const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());
const server = http.createServer(app);

// Allow from your front-end origin in dev
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
});

// Track users by room
const roomUsers = new Map();

// Track game state by room
const roomGames = new Map();

// Track correct guessers for current round
const roomCorrectGuessers = new Map();

// Track timer intervals by room
const roomTimers = new Map();

// Track turn order by room (user IDs in the order they joined)
const roomTurnOrder = new Map();

// Track current turn index by room
const roomTurnIndex = new Map();

// Utility: get room from query or default
const getRoom = (socket) => socket.handshake.query.room || "default";

// Utility: get user info from socket
const getUserInfo = (socket) => ({
    id: socket.id,
    userName: socket.handshake.query.userName || `User ${socket.id.slice(0, 6)}`,
    joinedAt: new Date().toISOString()
});

// Utility: update room users and emit changes
const updateRoomUsers = (room) => {
    const users = Array.from(roomUsers.get(room)?.values() || []);
    io.to(room).emit("users:update", users);
};

// Utility: initialize game for room
const initializeGame = (room) => {
    if (!roomGames.has(room)) {
        roomGames.set(room, {
            currentDrawer: null,
            currentWord: null,
            gameStarted: false,
            turnStartTime: null,
            timerEndTime: null
        });
    }
    return roomGames.get(room);
};

// Utility: clear timer for room
const clearTimer = (room) => {
    if (roomTimers.has(room)) {
        clearInterval(roomTimers.get(room));
        roomTimers.delete(room);
    }
    const game = roomGames.get(room);
    if (game) {
        game.timerEndTime = null;
    }
};

// Utility: start timer for room
const startTimer = (room, durationSeconds = 60) => {
    clearTimer(room); // Clear any existing timer

    const game = roomGames.get(room);
    if (!game) return;

    game.timerEndTime = Date.now() + durationSeconds * 1000;

    // Emit initial timer
    io.to(room).emit("timer:update", {
        remaining: durationSeconds,
        total: durationSeconds
    });

    // Set up interval to update timer every second
    const interval = setInterval(() => {
        const now = Date.now();
        const remaining = Math.max(0, Math.ceil((game.timerEndTime - now) / 1000));

        io.to(room).emit("timer:update", {
            remaining: remaining,
            total: durationSeconds
        });

        if (remaining <= 0) {
            clearTimer(room);
            // Start new turn when timer ends
            startNewTurn(room);
        }
    }, 1000);

    roomTimers.set(room, interval);
};

// Utility: start a new turn by picking next drawer in order
const startNewTurn = (room) => {
    const users = Array.from(roomUsers.get(room).values());
    if (users.length === 0) return;

    // Initialize turn order if not exists (order of first joining)
    if (!roomTurnOrder.has(room)) {
        roomTurnOrder.set(room, users.map(u => u.id));
        roomTurnIndex.set(room, 0);
    }

    // Get current turn index, wrap around if needed
    let currentIndex = roomTurnIndex.get(room) || 0;
    const turnOrder = roomTurnOrder.get(room);

    // Find the next valid user (still connected)
    let nextDrawer = null;
    let attempts = 0;
    const maxAttempts = users.length;

    while (!nextDrawer && attempts < maxAttempts) {
        const userId = turnOrder[currentIndex];
        nextDrawer = users.find(u => u.id === userId);

        if (!nextDrawer) {
            // User left, skip them
            currentIndex = (currentIndex + 1) % turnOrder.length;
            attempts++;
        } else {
            // Found valid drawer, update index for next turn
            roomTurnIndex.set(room, (currentIndex + 1) % turnOrder.length);
            break;
        }
    }

    // Fallback to first available user if no valid drawer found
    if (!nextDrawer) {
        nextDrawer = users[0];
        roomTurnIndex.set(room, 1 % users.length);
    }

    // Clear any existing timer
    clearTimer(room);

    const game = initializeGame(room);

    game.currentDrawer = nextDrawer.id;
    game.currentWord = null;
    game.gameStarted = true;
    game.turnStartTime = Date.now();

    // Reset correct guessers for new round
    roomCorrectGuessers.set(room, new Set());

    // Emit turn start event to all users in room
    io.to(room).emit("turn:start", {
        drawer: nextDrawer,
        turnStartTime: game.turnStartTime
    });

    console.log(`🎨 New turn started in room ${room}. Drawer: ${nextDrawer.userName} (orderly turn)`);
};

io.on("connection", (socket) => {
    const room = getRoom(socket);
    const userInfo = getUserInfo(socket);

    // Initialize room users if not exists
    if (!roomUsers.has(room)) {
        roomUsers.set(room, new Map());
    }

    // Add user to room
    const wasEmpty = roomUsers.get(room).size === 0;
    roomUsers.get(room).set(socket.id, userInfo);
    socket.join(room);

    // If user joins after game has started, add them to turn order
    if (roomTurnOrder.has(room) && !wasEmpty) {
        const turnOrder = roomTurnOrder.get(room);
        turnOrder.push(socket.id);
    }

    console.log(`🔗 User ${userInfo.userName} (${socket.id}) connected to room: ${room}`);

    // Send current users list to the new user
    socket.emit("users:update", Array.from(roomUsers.get(room).values()));

    // Notify others about new user
    socket.to(room).emit("user:joined", userInfo);



    // Receive a streamed line segment; broadcast to others in the same room
    socket.on("segment", (payload) => {
        // { x0, y0, x1, y1, color, width, dpr }
        console.log(`🔗 User ${userInfo.userName} sent a segment to room: ${room}`);
        socket.to(room).emit("segment", payload);
    });

    // Clear canvas for everyone
    socket.on("clear", () => {
        socket.to(room).emit("clear");
    });

    // Optional: broadcast cursor positions so others see your pointer
    socket.on("cursor", (pos) => {
        // { x, y }
        socket.to(room).emit("cursor", { id: socket.id, ...pos });
    });

    // Handle word selection from drawer
    socket.on("word:select", (word) => {
        const game = roomGames.get(room);
        if (!game || game.currentDrawer !== socket.id) {
            return; // Only current drawer can select word
        }

        game.currentWord = word;

        // Emit word selected event to all users in room
        io.to(room).emit("word:selected", {
            word: word,
            drawer: userInfo
        });

        // Start timer when word is selected
        startTimer(room, 60); // 60 seconds timer

        console.log(`📝 Word selected in room ${room}: "${word}" by ${userInfo.userName}`);
    });

    // Handle game start from room creator
    socket.on("game:start", () => {
        const game = initializeGame(room);
        if (game.gameStarted) {
            return; // Game already started
        }

        // Check if user is the room creator (first user)
        const users = Array.from(roomUsers.get(room).values());
        const isRoomCreator = users.length > 0 && users[0].id === socket.id;

        if (!isRoomCreator) {
            return; // Only room creator can start the game
        }

        startNewTurn(room);
        console.log(`🎮 Game started in room ${room} by ${userInfo.userName}`);
    });

    // Handle chat messages
    socket.on("chat:message", (message) => {
        console.log(`💬 ${userInfo.userName} in room ${room}: ${message}`);

        const game = roomGames.get(room);

        // Check if this is a correct guess during an active game
        if (game && game.currentWord && game.currentDrawer !== socket.id) {
            // Check if user already guessed correctly this round
            if (!roomCorrectGuessers.has(room)) {
                roomCorrectGuessers.set(room, new Set());
            }
            const correctGuessers = roomCorrectGuessers.get(room);
            if (!correctGuessers.has(socket.id)) {
                // Check if guess is correct (case insensitive)
                if (message.toLowerCase().trim() === game.currentWord.toLowerCase()) {
                    // Add to correct guessers
                    correctGuessers.add(socket.id);

                    // Calculate points based on position
                    const guessPosition = correctGuessers.size;
                    let points = 0;
                    if (guessPosition === 1) points = 100;
                    else if (guessPosition === 2) points = 75;
                    else if (guessPosition === 3) points = 50;
                    else if (guessPosition <= 5) points = 25;
                    else points = 10;

                    // Update user points
                    const user = roomUsers.get(room).get(socket.id);
                    if (user) {
                        user.points = (user.points || 0) + points;
                    }

                    // Broadcast updated user list with new points
                    updateRoomUsers(room);

                    // Emit correct guess event
                    io.to(room).emit("guess:correct", {
                        userName: userInfo.userName,
                        points: points,
                        position: guessPosition,
                        totalCorrect: correctGuessers.size
                    });

                    // Emit special chat message for correct guess
                    io.to(room).emit("chat:message", {
                        id: Date.now() + Math.random(),
                        userName: userInfo.userName,
                        message: `🎉 Correct! +${points} points`,
                        timestamp: Date.now(),
                        isCorrectGuess: true,
                        points: points,
                        position: guessPosition
                    });

                    console.log(`✅ ${userInfo.userName} guessed correctly in room ${room}! +${points} points (position ${guessPosition})`);
                    return; // Don't send the original message if it was a correct guess
                }
            }
        }

        // Broadcast the regular chat message to all users in the room
        io.to(room).emit("chat:message", {
            id: Date.now() + Math.random(), // Simple unique ID
            userName: userInfo.userName,
            message: message,
            timestamp: Date.now()
        });
    });



    socket.on("disconnect", () => {
        // Remove user from room
        if (roomUsers.has(room)) {
            const user = roomUsers.get(room).get(socket.id);
            roomUsers.get(room).delete(socket.id);

            // Clean up empty room
            if (roomUsers.get(room).size === 0) {
                roomUsers.delete(room);
            }

            // Notify others about user leaving
            socket.to(room).emit("user:left", { id: socket.id });
            updateRoomUsers(room);

            console.log(`🔗 User ${user?.userName || socket.id} disconnected from room: ${room}`);
        }
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`✅ Socket.IO server on :${PORT}`));
