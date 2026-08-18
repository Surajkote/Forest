import React, { useState, useEffect, useRef, useCallback } from 'react';

const MAX_LEVELS = 10;
const STORAGE_KEY = 'forest_labyrinth_state_v2';

interface SavedState {
    level: number;
    playerPos: { x: number; y: number };
    designVariant: number;
    isComplete: boolean;
}

interface LabyrinthGameProps {
    onBack?: () => void;
}

// Seeded PRNG for consistent, perfectly solvable mazes
function createPRNG(seed: number) {
    let s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return () => {
        s = (s * 16807) % 2147483647;
        return (s - 1) / 2147483646;
    };
}

// Generate massive, complex solvable maze grid (0 = Path, 1 = Wall)
function generateMaze(level: number, variant: number) {
  // SETTING THIS TO 51 CREATES A MASSIVE, HIGHLY COMPLEX GRID
  const size = 51; 
  const rows = size;
  const cols = size;

  const grid: number[][] = Array.from({ length: rows }, () => Array(cols).fill(1));
  const rng = createPRNG(level * 7919 + variant * 104729 + 1337);

  const stack: [number, number][] = [];
  grid[1][1] = 0;
  stack.push([1, 1]);

  const directions = [
    [0, -2],
    [0, 2],
    [-2, 0],
    [2, 0],
  ];

  while (stack.length > 0) {
    const [cx, cy] = stack[stack.length - 1];
    const neighbors: [number, number, number, number][] = [];

    for (const [dx, dy] of directions) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx > 0 && nx < cols - 1 && ny > 0 && ny < rows - 1 && grid[ny][nx] === 1) {
        neighbors.push([nx, ny, cx + dx / 2, cy + dy / 2]);
      }
    }

    if (neighbors.length > 0) {
      const idx = Math.floor(rng() * neighbors.length);
      const [nx, ny, wx, wy] = neighbors[idx];
      grid[wy][wx] = 0;
      grid[ny][nx] = 0;
      stack.push([nx, ny]);
    } else {
      stack.pop();
    }
  }

  // Ensure end goal is open
  grid[rows - 2][cols - 2] = 0;
  return { grid, rows, cols };
}

export function LabyrinthGame({ onBack }: LabyrinthGameProps) {
    const [gameState, setGameState] = useState<SavedState>(() => {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            try {
                return JSON.parse(saved);
            } catch (e) {
                console.error('Failed to load labyrinth save', e);
            }
        }
        return {
            level: 1,
            playerPos: { x: 1, y: 1 },
            designVariant: 0,
            isComplete: false,
        };
    });

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [canvasDim, setCanvasDim] = useState<number>(260);

    // Build maze layout based on current state
    const maze = React.useMemo(() => {
        return generateMaze(gameState.level, gameState.designVariant);
    }, [gameState.level, gameState.designVariant]);

    // Sync state to localStorage immediately
    useEffect(() => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(gameState));
    }, [gameState]);

    // 2. MAXIMIZE CANVAS SIZE (Replace your handleResize useEffect)
    useEffect(() => {
        const handleResize = () => {
            if (containerRef.current) {
                const { clientWidth, clientHeight } = containerRef.current;
                // Expand fully to the edges with minimal 4px padding
                const size = Math.min(clientWidth, clientHeight) - 4;
                setCanvasDim(size);
            }
        };

        handleResize();
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // Handle movement with instant collision detection
    const movePlayer = useCallback(
        (dx: number, dy: number) => {
            if (gameState.isComplete) return;

            const targetX = gameState.playerPos.x + dx;
            const targetY = gameState.playerPos.y + dy;

            // Check boundary and wall collisions (0 = movable path)
            if (
                targetY >= 0 &&
                targetY < maze.rows &&
                targetX >= 0 &&
                targetX < maze.cols &&
                maze.grid[targetY][targetX] === 0
            ) {
                // Reached Level Goal
                if (targetX === maze.cols - 2 && targetY === maze.rows - 2) {
                    if (gameState.level < MAX_LEVELS) {
                        setGameState((prev) => ({
                            ...prev,
                            level: prev.level + 1,
                            playerPos: { x: 1, y: 1 },
                        }));
                    } else {
                        // Completed Level 10
                        setGameState((prev) => ({
                            ...prev,
                            isComplete: true,
                        }));
                    }
                } else {
                    setGameState((prev) => ({
                        ...prev,
                        playerPos: { x: targetX, y: targetY },
                    }));
                }
            }
        },
        [gameState, maze]
    );

    // Keyboard navigation listener (Arrow keys & WASD)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) {
                e.preventDefault();
            }

            switch (e.code) {
                case 'ArrowUp':
                case 'KeyW':
                    movePlayer(0, -1);
                    break;
                case 'ArrowDown':
                case 'KeyS':
                    movePlayer(0, 1);
                    break;
                case 'ArrowLeft':
                case 'KeyA':
                    movePlayer(-1, 0);
                    break;
                case 'ArrowRight':
                case 'KeyD':
                    movePlayer(1, 0);
                    break;
                default:
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [movePlayer]);

    // Render Canvas (Dark movable space, lighter structural walls)
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const { grid, rows, cols } = maze;
        const cellW = canvasDim / cols;
        const cellH = canvasDim / rows;

        ctx.clearRect(0, 0, canvasDim, canvasDim);

        // 1. Draw Maze Cells
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (grid[r][c] === 1) {
                    // Structural Wall: Lighter border/fill contrast
                    ctx.fillStyle = '#1c2333';
                    ctx.fillRect(c * cellW, r * cellH, cellW + 0.5, cellH + 0.5);
                } else {
                    // Movable Space: Deep dark background
                    ctx.fillStyle = '#07090e';
                    ctx.fillRect(c * cellW, r * cellH, cellW, cellH);
                }
            }
        }

        // 2. Draw Exit Goal (Glowing Green Indicator)
        const goalX = (cols - 2) * cellW + cellW / 2;
        const goalY = (rows - 2) * cellH + cellH / 2;
        const goalRadius = Math.max(2, Math.min(cellW, cellH) * 0.35);

        ctx.beginPath();
        ctx.arc(goalX, goalY, goalRadius, 0, Math.PI * 2);
        ctx.fillStyle = '#10b981';
        ctx.shadowColor = '#10b981';
        ctx.shadowBlur = 8;
        ctx.fill();
        ctx.shadowBlur = 0;

        // 3. Draw Player Dot (Glowing Amber / Gold)
        const pX = gameState.playerPos.x * cellW + cellW / 2;
        const pY = gameState.playerPos.y * cellH + cellH / 2;
        const pRadius = Math.max(3, Math.min(cellW, cellH) * 0.38);

        ctx.beginPath();
        ctx.arc(pX, pY, pRadius, 0, Math.PI * 2);
        ctx.fillStyle = '#f59e0b';
        ctx.shadowColor = '#f59e0b';
        ctx.shadowBlur = 10;
        ctx.fill();
        ctx.shadowBlur = 0;
    }, [maze, gameState.playerPos, canvasDim]);

    // Restart trigger: Accessible ONLY after conquering Level 10
    const handleRestartFromBeginning = () => {
        setGameState((prev) => ({
            level: 1,
            playerPos: { x: 1, y: 1 },
            designVariant: prev.designVariant + 1,
            isComplete: false,
        }));
    };

    // Victory Screen (Levels 1-9 never render a reset button)
    if (gameState.isComplete) {
        return (
            <div className="flex flex-col items-center justify-center h-full p-4 text-center select-none bg-[#090b10]">
                <div className="w-12 h-12 rounded-2xl bg-amber-400/10 border border-amber-400/30 flex items-center justify-center text-2xl mb-3 shadow-lg shadow-amber-400/10">
                    🏆
                </div>
                <h2 className="text-base font-bold bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-500 bg-clip-text text-transparent">
                    All 10 Mazes Cleared!
                </h2>
                <p className="text-[11px] text-gray-400 mt-1.5 max-w-[220px] leading-relaxed">
                    You conquered every level. Reset to play a brand-new randomized maze set.
                </p>

                <button
                    onClick={handleRestartFromBeginning}
                    className="mt-5 px-5 py-2 bg-gradient-to-r from-amber-400 to-yellow-500 hover:from-amber-300 hover:to-yellow-400 text-black font-bold text-xs rounded-xl shadow-lg shadow-amber-400/20 transition-all hover:scale-105 active:scale-95"
                >
                    Restart Level 1 (New Mazes)
                </button>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full w-full p-2 select-none overflow-hidden bg-[#090b10]">
            {/* Top Header: Compact Back Tag on Left & Level on Right */}
            <div className="flex items-center justify-between w-full px-1 pb-1.5 z-10">
                {onBack ? (
                    <button
                        onClick={onBack}
                        className="flex items-center gap-1 text-[10px] font-medium text-gray-400 hover:text-white px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 transition-colors"
                    >
                        ← Back
                    </button>
                ) : (
                    <div />
                )}

                <span className="font-mono text-[10px] font-bold text-amber-300 bg-amber-400/10 border border-amber-400/20 px-2 py-0.5 rounded shadow-sm">
                    {gameState.level} / {MAX_LEVELS}
                </span>
            </div>

            {/* Maximized Maze Arena */}
            <div
                ref={containerRef}
                className="flex-1 w-full flex items-center justify-center min-h-0 overflow-hidden"
            >
                <canvas
                    ref={canvasRef}
                    width={canvasDim}
                    height={canvasDim}
                    className="rounded-xl border border-white/10 shadow-2xl bg-[#07090e]"
                />
            </div>
        </div>
    );
}
export { LabyrinthGame as MazeGame };
export default LabyrinthGame;