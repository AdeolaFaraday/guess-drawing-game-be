// Game logic module for drawing game
// Handles room management, user connections, game state, and events

class GameLogic {
    constructor() {
        // Track users by room: Map<room, Map<userId, userInfo>>
        this.roomUsers = new Map();

        // Track game state by room
        this.roomGames = new Map();

        // Track correct guessers for current round: Map<room, Set<userId>>
        this.roomCorrectGuessers = new Map();

        // Track timer intervals by room: Map<room, intervalId>
        this.roomTimers = new Map();

        // Track active connections by room: Map<room, Set<call>>
        this.roomConnections = new Map();
    }

    // Utility: get room from request or default
    getRoom(request) {
        return request.room || "default";
    }

    // Utility: get user info
    getUserInfo(userId, userName) {
        return {
            id: userId,
            userName: userName || `User ${userId.slice(0, 6)}`,
            points: 0,
            joinedAt: new Date().toISOString()
        };
    }

    // Utility: update room users and notify all connections
    updateRoomUsers(room) {
        const users = Array.from(this.roomUsers.get(room)?.values() || []);
        this.broadcastToRoom(room, {
            room: room,
            usersUpdate: users
        });
    }

    // Utility: initialize game for room
    initializeGame(room) {
        if (!this.roomGames.has(room)) {
            this.roomGames.set(room, {
                currentDrawer: null,
                currentWord: null,
                gameStarted: false,
                turnStartTime: null,
                timerEndTime: null
            });
        }
        return this.roomGames.get(room);
    }

    // Utility: clear timer for room
    clearTimer(room) {
        if (this.roomTimers.has(room)) {
            clearInterval(this.roomTimers.get(room));
            this.roomTimers.delete(room);
        }
        const game = this.roomGames.get(room);
        if (game) {
            game.timerEndTime = null;
        }
    }

    // Utility: start timer for room
    startTimer(room, durationSeconds = 60) {
        this.clearTimer(room); // Clear any existing timer

        const game = this.roomGames.get(room);
        if (!game) return;

        game.timerEndTime = Date.now() + durationSeconds * 1000;

        // Emit initial timer
        this.broadcastToRoom(room, {
            room: room,
            timerUpdate: {
                remaining: durationSeconds,
                total: durationSeconds
            }
        });

        // Set up interval to update timer every second
        const interval = setInterval(() => {
            const now = Date.now();
            const remaining = Math.max(0, Math.ceil((game.timerEndTime - now) / 1000));

            this.broadcastToRoom(room, {
                room: room,
                timerUpdate: {
                    remaining: remaining,
                    total: durationSeconds
                }
            });

            if (remaining <= 0) {
                this.clearTimer(room);
                // Start new turn when timer ends
                this.startNewTurn(room);
            }
        }, 1000);

        this.roomTimers.set(room, interval);
    }

    // Utility: start a new turn by picking random drawer
    startNewTurn(room) {
        const users = Array.from(this.roomUsers.get(room).values());
        if (users.length === 0) return;

        // Clear any existing timer
        this.clearTimer(room);

        const randomUser = users[Math.floor(Math.random() * users.length)];
        const game = this.initializeGame(room);

        game.currentDrawer = randomUser.id;
        game.currentWord = null;
        game.gameStarted = true;
        game.turnStartTime = Date.now();

        // Reset correct guessers for new round
        this.roomCorrectGuessers.set(room, new Set());

        // Emit turn start event to all users in room
        this.broadcastToRoom(room, {
            room: room,
            turnStart: {
                drawer: randomUser,
                turnStartTime: game.turnStartTime
            }
        });

        console.log(`🎨 New turn started in room ${room}. Drawer: ${randomUser.userName}`);
    }

    // Broadcast event to all connections in a room
    broadcastToRoom(room, event, excludeCall = null) {
        const connections = this.roomConnections.get(room);
        if (connections) {
            connections.forEach(call => {
                if (call !== excludeCall) {
                    try {
                        call.write(event);
                    } catch (error) {
                        console.error('Error writing to call:', error);
                    }
                }
            });
        }
    }

    // Handle user joining
    handleJoin(call, request) {
        const room = this.getRoom(request);
        const userInfo = this.getUserInfo(call.metadata.get('userId')[0] || 'unknown', request.userName);

        // Initialize room users if not exists
        if (!this.roomUsers.has(room)) {
            this.roomUsers.set(room, new Map());
        }

        // Initialize room connections if not exists
        if (!this.roomConnections.has(room)) {
            this.roomConnections.set(room, new Set());
        }

        // Add user to room
        this.roomUsers.get(room).set(userInfo.id, userInfo);
        this.roomConnections.get(room).add(call);

        console.log(`🔗 User ${userInfo.userName} (${userInfo.id}) connected to room: ${room}`);

        // Send current users list to the new user
        call.write({
            room: room,
            usersUpdate: Array.from(this.roomUsers.get(room).values())
        });

        // Notify others about new user
        this.broadcastToRoom(room, {
            room: room,
            userJoined: userInfo
        }, call); // Exclude the joining user
    }

    // Handle user leaving
    handleLeave(call, room) {
        if (this.roomUsers.has(room)) {
            const userId = call.metadata.get('userId')[0] || 'unknown';
            const user = this.roomUsers.get(room).get(userId);
            this.roomUsers.get(room).delete(userId);

            // Remove connection
            if (this.roomConnections.has(room)) {
                this.roomConnections.get(room).delete(call);
            }

            // Clean up empty room
            if (this.roomUsers.get(room).size === 0) {
                this.roomUsers.delete(room);
                this.roomConnections.delete(room);
                this.roomGames.delete(room);
                this.roomCorrectGuessers.delete(room);
                this.clearTimer(room);
            }

            // Notify others about user leaving
            this.broadcastToRoom(room, {
                room: room,
                userLeft: { id: userId }
            });
            this.updateRoomUsers(room);

            console.log(`🔗 User ${user?.userName || userId} disconnected from room: ${room}`);
        }
    }

    // Handle drawing segment
    handleSegment(call, room, segment) {
        const userId = call.metadata.get('userId')[0] || 'unknown';
        const user = this.roomUsers.get(room)?.get(userId);
        console.log(`🔗 User ${user?.userName} sent a segment to room: ${room}`);
        this.broadcastToRoom(room, {
            room: room,
            userId: userId,
            segment: segment
        }, call); // Broadcast to others
    }

    // Handle clear canvas
    handleClear(call, room) {
        this.broadcastToRoom(room, {
            room: room,
            clear: ""
        }, call);
    }

    // Handle cursor position
    handleCursor(call, room, cursor) {
        const userId = call.metadata.get('userId')[0] || 'unknown';
        this.broadcastToRoom(room, {
            room: room,
            userId: userId,
            cursor: cursor
        }, call);
    }

    // Handle word selection
    handleWordSelect(call, room, word) {
        const userId = call.metadata.get('userId')[0] || 'unknown';
        const game = this.roomGames.get(room);
        if (!game || game.currentDrawer !== userId) {
            return; // Only current drawer can select word
        }

        game.currentWord = word;

        const user = this.roomUsers.get(room)?.get(userId);

        // Emit word selected event to all users in room
        this.broadcastToRoom(room, {
            room: room,
            wordSelected: {
                word: word,
                drawer: user
            }
        });

        // Start timer when word is selected
        this.startTimer(room, 60); // 60 seconds timer

        console.log(`📝 Word selected in room ${room}: "${word}" by ${user?.userName}`);
    }

    // Handle game start
    handleGameStart(call, room) {
        const game = this.initializeGame(room);
        if (game.gameStarted) {
            return; // Game already started
        }

        const userId = call.metadata.get('userId')[0] || 'unknown';
        // Check if user is the room creator (first user)
        const users = Array.from(this.roomUsers.get(room).values());
        const isRoomCreator = users.length > 0 && users[0].id === userId;

        if (!isRoomCreator) {
            return; // Only room creator can start the game
        }

        this.startNewTurn(room);
        console.log(`🎮 Game started in room ${room}`);
    }

    // Handle chat message
    handleChatMessage(call, room, message) {
        const userId = call.metadata.get('userId')[0] || 'unknown';
        const user = this.roomUsers.get(room)?.get(userId);
        console.log(`💬 ${user?.userName} in room ${room}: ${message}`);

        const game = this.roomGames.get(room);

        // Check if this is a correct guess during an active game
        if (game && game.currentWord && game.currentDrawer !== userId) {
            // Check if user already guessed correctly this round
            if (!this.roomCorrectGuessers.has(room)) {
                this.roomCorrectGuessers.set(room, new Set());
            }
            const correctGuessers = this.roomCorrectGuessers.get(room);
            if (!correctGuessers.has(userId)) {
                // Check if guess is correct (case insensitive)
                if (message.toLowerCase().trim() === game.currentWord.toLowerCase()) {
                    // Add to correct guessers
                    correctGuessers.add(userId);

                    // Calculate points based on position
                    const guessPosition = correctGuessers.size;
                    let points = 0;
                    if (guessPosition === 1) points = 100;
                    else if (guessPosition === 2) points = 75;
                    else if (guessPosition === 3) points = 50;
                    else if (guessPosition <= 5) points = 25;
                    else points = 10;

                    // Update user points
                    if (user) {
                        user.points = (user.points || 0) + points;
                    }

                    // Broadcast updated user list with new points
                    this.updateRoomUsers(room);

                    // Emit correct guess event
                    this.broadcastToRoom(room, {
                        room: room,
                        guessCorrect: {
                            userName: user?.userName,
                            points: points,
                            position: guessPosition,
                            totalCorrect: correctGuessers.size
                        }
                    });

                    // Emit special chat message for correct guess
                    this.broadcastToRoom(room, {
                        room: room,
                        chatMessageResponse: {
                            id: Date.now() + Math.random(),
                            userName: user?.userName,
                            message: `🎉 Correct! +${points} points`,
                            timestamp: Date.now(),
                            isCorrectGuess: true,
                            points: points,
                            position: guessPosition
                        }
                    });

                    console.log(`✅ ${user?.userName} guessed correctly in room ${room}! +${points} points (position ${guessPosition})`);
                    return; // Don't send the original message if it was a correct guess
                }
            }
        }

        // Broadcast the regular chat message to all users in the room
        this.broadcastToRoom(room, {
            room: room,
            chatMessageResponse: {
                id: Date.now() + Math.random(),
                userName: user?.userName,
                message: message,
                timestamp: Date.now()
            }
        });
    }

    // Clean up when connection ends
    cleanup(call) {
        // Find room for this call
        for (const [room, connections] of this.roomConnections) {
            if (connections.has(call)) {
                this.handleLeave(call, room);
                break;
            }
        }
    }
}

module.exports = GameLogic;
