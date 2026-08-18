import json
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from langchain_core.messages import HumanMessage
from agent import agent_executor

app = FastAPI()

@app.websocket("/ws/agent")
async def agent_websocket(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            # Receive task from Tauri/React frontend
            data = await websocket.receive_text()
            request = json.loads(data)
            user_prompt = request.get("task", "")

            # Stream graph execution events live
            inputs = {"messages": [HumanMessage(content=user_prompt)]}
            
            # Increase recursion limit to allow deep multi-step research
            config = {"recursion_limit": 60}

            try:
                async for event in agent_executor.astream_events(inputs, config=config, version="v2"):
                    event_type = event["event"]
                    
                    if event_type == "on_chat_model_stream":
                        chunk = event["data"]["chunk"]
                        if chunk.content:
                            await websocket.send_json({
                                "type": "thought_stream",
                                "content": chunk.content
                            })

                    elif event_type == "on_tool_start":
                        await websocket.send_json({
                            "type": "tool_start",
                            "tool": event["name"],
                            "input": event["data"].get("input")
                        })

                    elif event_type == "on_tool_end":
                        await websocket.send_json({
                            "type": "tool_end",
                            "tool": event["name"],
                            "output": str(event["data"].get("output"))
                        })

                await websocket.send_json({"type": "complete"})

            except Exception as task_err:
                # Catch recursion limits or timeouts without dropping the WebSocket
                await websocket.send_json({
                    "type": "tool_end",
                    "output": f"Task execution warning: {str(task_err)}"
                })
                await websocket.send_json({"type": "complete"})

    except WebSocketDisconnect:
        print("Client disconnected.")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8765)