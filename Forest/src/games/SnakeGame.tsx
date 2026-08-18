import { useEffect, useRef } from 'react';

const GRID_SIZE = 30;
const COLS = 26;
const ROWS = 20;
const TICK_RATE_MS = 90;

type Point = { x: number, y: number };

export const SnakeGame = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const gameState = useRef({
        state: 'playing' as 'playing' | 'gameover' | 'paused',
        snake: [{ x: 6, y: 10 }, { x: 5, y: 10 }, { x: 4, y: 10 }] as Point[],
        direction: { dx: 1, dy: 0 },
        nextDirection: { dx: 1, dy: 0 },
        food: { x: 15, y: 10 } as Point,
        lastTick: 0,
        score: 0,
        highScore: 0
    });

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let animationFrameId: number;

        const spawnFood = (snake: Point[]) => {
            let newFood: Point;
            let isOccupied = true;
            while (isOccupied) {
                newFood = {
                    x: Math.floor(Math.random() * COLS),
                    y: Math.floor(Math.random() * ROWS)
                };
                // eslint-disable-next-line no-loop-func
                isOccupied = snake.some(segment => segment.x === newFood.x && segment.y === newFood.y);
            }
            return newFood!;
        };

        const resetGame = () => {
            gameState.current.snake = [{ x: 6, y: 10 }, { x: 5, y: 10 }, { x: 4, y: 10 }];
            gameState.current.direction = { dx: 1, dy: 0 };
            gameState.current.nextDirection = { dx: 1, dy: 0 };
            gameState.current.food = spawnFood(gameState.current.snake);
            gameState.current.state = 'playing';
            gameState.current.score = 0;
        };

        const handleKeyDown = (e: KeyboardEvent) => {
            const { direction, state } = gameState.current;

            if (e.key === ' ' || e.code === 'Space') {
                e.preventDefault();
                if (state === 'gameover') resetGame();
                else if (state === 'playing') gameState.current.state = 'paused';
                else if (state === 'paused') gameState.current.state = 'playing';
                return;
            }

            if (state !== 'playing') return;

            if (e.key === 'ArrowUp' && direction.dy === 0) { gameState.current.nextDirection = { dx: 0, dy: -1 }; e.preventDefault(); }
            else if (e.key === 'ArrowDown' && direction.dy === 0) { gameState.current.nextDirection = { dx: 0, dy: 1 }; e.preventDefault(); }
            else if (e.key === 'ArrowLeft' && direction.dx === 0) { gameState.current.nextDirection = { dx: -1, dy: 0 }; e.preventDefault(); }
            else if (e.key === 'ArrowRight' && direction.dx === 0) { gameState.current.nextDirection = { dx: 1, dy: 0 }; e.preventDefault(); }
        };

        window.addEventListener('keydown', handleKeyDown, { passive: false });

        const update = (timestamp: number) => {
            if (gameState.current.state !== 'playing') return;
            if (timestamp - gameState.current.lastTick < TICK_RATE_MS) return;
            gameState.current.lastTick = timestamp;

            const state = gameState.current;
            state.direction = state.nextDirection;

            const head = state.snake[0];
            const newHead = { x: head.x + state.direction.dx, y: head.y + state.direction.dy };

            if (newHead.x < 0 || newHead.x >= COLS || newHead.y < 0 || newHead.y >= ROWS) {
                state.state = 'gameover';
                return;
            }

            for (const segment of state.snake) {
                if (newHead.x === segment.x && newHead.y === segment.y) {
                    state.state = 'gameover';
                    return;
                }
            }

            state.snake.unshift(newHead);

            if (newHead.x === state.food.x && newHead.y === state.food.y) {
                state.score += 10;
                if (state.score > state.highScore) state.highScore = state.score;
                state.food = spawnFood(state.snake);
            } else {
                state.snake.pop();
            }
        };

        const draw = () => {
            ctx.fillStyle = '#1e293b';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            const { state, snake, food, score, highScore } = gameState.current;

            // Draw Food
            ctx.fillStyle = '#dc2626';
            ctx.beginPath();
            ctx.roundRect(food.x * GRID_SIZE + 2, food.y * GRID_SIZE + 2, GRID_SIZE - 4, GRID_SIZE - 4, 6);
            ctx.fill();

            // Draw Snake
            snake.forEach((segment, index) => {
                ctx.fillStyle = index === 0 ? '#f59e0b' : '#d97706';
                ctx.beginPath();
                ctx.roundRect(segment.x * GRID_SIZE + 1, segment.y * GRID_SIZE + 1, GRID_SIZE - 2, GRID_SIZE - 2, 4);
                ctx.fill();
            });

            // UI: In-Canvas Scoreboard (Top Right)
            ctx.fillStyle = 'rgba(15, 23, 42, 0.7)';
            ctx.beginPath();
            ctx.roundRect(canvas.width - 200, 10, 180, 70, 8);
            ctx.fill();

            ctx.fillStyle = '#f59e0b';
            ctx.font = 'bold 20px monospace';
            ctx.textAlign = 'right';
            ctx.fillText(`SCORE: ${score}`, canvas.width - 35, 35);
            ctx.fillStyle = '#dc2626';
            ctx.fillText(`HIGH:  ${highScore}`, canvas.width - 35, 65);

            // Status Overlays
            ctx.textAlign = 'center';
            if (state === 'gameover') {
                ctx.fillStyle = 'rgba(0,0,0,0.7)';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.fillStyle = '#ef4444';
                ctx.font = 'bold 60px sans-serif';
                ctx.fillText('CRASHED', canvas.width / 2, canvas.height / 2 - 20);
                ctx.fillStyle = 'white';
                ctx.font = '24px sans-serif';
                ctx.fillText('Press SPACE to Restart', canvas.width / 2, canvas.height / 2 + 30);
            } else if (state === 'paused') {
                ctx.fillStyle = 'rgba(0,0,0,0.5)';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.fillStyle = 'white';
                ctx.font = 'bold 50px sans-serif';
                ctx.fillText('PAUSED', canvas.width / 2, canvas.height / 2);
            }
        };

        const loop = (timestamp: number) => {
            update(timestamp);
            draw();
            animationFrameId = requestAnimationFrame(loop);
        };

        animationFrameId = requestAnimationFrame(loop);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            cancelAnimationFrame(animationFrameId);
        };
    }, []);

    return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
      {/* 
        The minHeight: 0 here strictly enforces the flexbox boundaries, 
        ensuring the canvas scales down without clipping the bottom.
      */}
      <div style={{ flex: 1, width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 0, padding: '10px' }}>
          <canvas 
            ref={canvasRef} 
            width={COLS * GRID_SIZE} 
            height={ROWS * GRID_SIZE} 
            style={{ 
                maxWidth: '100%', maxHeight: '100%', objectFit: 'contain',
                background: '#1e293b', borderRadius: '12px', border: '4px solid #334155',
                boxSizing: 'border-box' // Prevents the border from adding extra overflow height
            }}
          />
      </div>
    </div>
  );
};