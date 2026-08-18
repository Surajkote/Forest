import { useEffect, useRef } from 'react';

const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<base href="https://cdn.jsdelivr.net/gh/bubbls/UGS-Assets@2ac7e5b354322a207bd059768f928ece8c9471c1/level%20devil/">
<head>
  <meta charset="utf-8">
  <title>Level Devil</title>
  <meta id="viewport" name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="robots" content="noindex,nofollow" />
  <link rel="shortcut icon" type="image/png" href="./favicon.png">
  <script src="./poki-sdk.js"></script>
  <script src="./Level Devil.js"></script>
  <script>
    window.addEventListener("touchmove", function(event) {
      event.preventDefault();
    }, { capture: false, passive: false });
    if (typeof window.devicePixelRatio != 'undefined' && window.devicePixelRatio > 2) {
      var meta = document.getElementById("viewport");
      meta.setAttribute('content', 'width=device-width, initial-scale=' + (2 / window.devicePixelRatio) + ', user-scalable=no');
    }
  </script>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
    #openfl-content { background: #000000; width: 100%; height: 100%; }
    #progress { position: relative; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 50%; }
  </style>
</head>
<body>
  <noscript>This webpage makes extensive use of JavaScript.</noscript>
  <div id="openfl-content"></div>
  <script>
    lime.embed("Level Devil", "openfl-content", 854, 480, { parameters: {} });
  </script>
</body>
</html>
`;

export const LevelDevilGame = () => {
    const iframeRef = useRef<HTMLIFrameElement>(null);

    // Automatically focus the iframe when the game loads so the keyboard controls work instantly
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
                    title="Level Devil"
                    srcDoc={htmlContent}
                    style={{
                        width: '100%',
                        height: '100%',
                        border: '4px solid #1e293b',
                        borderRadius: '12px',
                        boxSizing: 'border-box',
                        background: '#000000'
                    }}
                    // Ensures the iframe doesn't show scrollbars and acts like a canvas
                    scrolling="no"
                />
            </div>
        </div>
    );
};