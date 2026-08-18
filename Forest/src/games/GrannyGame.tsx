import { useEffect, useRef } from 'react';

const htmlContent = `
<!DOCTYPE html>
<html lang="en-us">
<head>
    <title>Granny Original</title>
    <meta charset="utf-8">
    <meta name="robots" content="noindex, nofollow">
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
    
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/bubbls/granny@212c543a85b243c4a0b92211f557e760d83d2292/TemplateData/style.css">
    <script src="https://cdn.jsdelivr.net/gh/bubbls/granny@212c543a85b243c4a0b92211f557e760d83d2292/sdk.js"></script>
    <style>
        body { margin: 0; padding: 0; overflow: hidden; background: url('https://cdn.jsdelivr.net/gh/gru6nny/ohd@main/background.png') no-repeat center center fixed; background-size: cover; cursor: crosshair; }
        #unity-container { position: absolute; width: 100%; height: 100%; left: 0; top: 0; }
        #unity-loading-bar { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 400px; height: 20px; background: rgba(0, 0, 0, 0.5); border: 2px solid #ffffff; border-radius: 10px; display: block; }
        #unity-logo { position: absolute; top: calc(50% - 100px); left: 50%; transform: translateX(-50%); width: 200px; height: auto; }
        #unity-logo img { max-width: 100%; height: auto; }
        #unity-progress-bar-empty { width: 100%; height: 100%; position: relative; }
        #unity-progress-bar-full { position: absolute; top: 0; left: 0; width: 0%; height: 100%; background: #4caf50; border-radius: 8px; transition: width 0.3s ease; }
    </style>
</head>
<body>
    <div id="unity-container">
        <canvas id="unity-canvas" style="position: absolute; width: 100%; height: 100%"></canvas>
        <div id="unity-loading-bar">
            <div id="unity-logo"></div>
            <div id="unity-progress-bar-empty">
                <div id="unity-progress-bar-full"></div>
            </div>
        </div>
    </div>
    <script>
        async function mergeUnityWebFiles(baseUrl, filePrefix, totalParts, extension) {
            const partUrls = [];
            for (let i = 1; i <= totalParts; i++) {
                partUrls.push(\`\${baseUrl}/\${filePrefix}_part\${i}.\${extension}\`);
            }
            const buffers = [];
            for (let i = 0; i < totalParts; i++) {
                const response = await fetch(partUrls[i]);
                if (!response.ok) throw new Error(\`Failed to load part: \${partUrls[i]}\`);
                buffers.push(await response.arrayBuffer());
                document.querySelector("#unity-progress-bar-full").style.width = \`\${((i + 1) / totalParts) * 100}%\`;
            }
            const totalLength = buffers.reduce((acc, buffer) => acc + buffer.byteLength, 0);
            const combinedBuffer = new Uint8Array(totalLength);
            let offset = 0;
            buffers.forEach((buffer) => {
                combinedBuffer.set(new Uint8Array(buffer), offset);
                offset += buffer.byteLength;
            });
            return combinedBuffer;
        }

        var canvas = document.querySelector("#unity-canvas");
        var loadingBar = document.querySelector("#unity-loading-bar");
        var progressBarFull = document.querySelector("#unity-progress-bar-full");

        var buildUrl = "https://cdn.jsdelivr.net/gh/gru6nny/ohd@main/Build";
        var loaderUrl = buildUrl + "/Granny.loader.js";

        async function initializeGame() {
            try {
                const dataBuffer = await mergeUnityWebFiles(buildUrl, "Granny", 2, "data");
                const wasmBuffer = await mergeUnityWebFiles(buildUrl, "Granny", 2, "wasm");
                const dataBlobUrl = URL.createObjectURL(new Blob([dataBuffer], { type: "application/octet-stream" }));
                const wasmBlobUrl = URL.createObjectURL(new Blob([wasmBuffer], { type: "application/octet-stream" }));

                var config = {
                    dataUrl: dataBlobUrl,
                    frameworkUrl: buildUrl + "/Granny.framework.js",
                    codeUrl: wasmBlobUrl,
                    streamingAssetsUrl: "https://cdn.jsdelivr.net/gh/gru6nny/ohd@main/StreamingAssets",
                    companyName: "Anastasia Kazantseva",
                    productName: "Granny",
                    productVersion: "1.0",
                };

                var script = document.createElement("script");
                script.src = loaderUrl;
                script.onload = () => {
                    createUnityInstance(canvas, config, (progress) => {
                        progressBarFull.style.width = 100 * progress + "%";
                    }).then((unityInstance) => {
                        loadingBar.style.display = "none";
                        
                        // --- SYSTEM LEVEL POINTER LOCK ---
                        // Binds directly to the document body using 'click' (the most reliable user-activation event)
                        const enforcePointerLock = () => {
                            if (document.pointerLockElement !== canvas) {
                                try {
                                    canvas.requestPointerLock = canvas.requestPointerLock || canvas.mozRequestPointerLock || canvas.webkitRequestPointerLock;
                                    canvas.requestPointerLock();
                                } catch (e) {
                                    console.error("Pointer lock failed:", e);
                                }
                            }
                        };
                        
                        document.body.addEventListener('click', enforcePointerLock);
                        canvas.addEventListener('click', enforcePointerLock);
                    });
                };
                document.body.appendChild(script);
            } catch (error) {
                console.error("Game initialization failed:", error);
            }
        }

        initializeGame();
    </script>
</body>
</html>
`;

export const GrannyGame = () => {
    const iframeRef = useRef<HTMLIFrameElement>(null);

    useEffect(() => {
        if (iframeRef.current) {
            iframeRef.current.focus();
        }
    }, []);

    return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
            <div style={{ flex: 1, width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 0, padding: '10px' }}>
                <iframe
                    ref={iframeRef}
                    title="Granny"
                    srcDoc={htmlContent}
                    allow="pointer-lock; autoplay; fullscreen"
                    style={{
                        width: '100%',
                        height: '100%',
                        border: '4px solid #1e293b',
                        borderRadius: '12px',
                        boxSizing: 'border-box',
                        background: '#000000'
                    }}
                    scrolling="no"
                />
            </div>
        </div>
    );
};