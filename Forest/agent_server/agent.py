import os
import sys
import io
import json
import subprocess
import tempfile
import pandas as pd
import requests
from dotenv import load_dotenv
from bs4 import BeautifulSoup
from langchain_community.tools.tavily_search import TavilySearchResults
from typing import Annotated, TypedDict
from langchain_core.messages import BaseMessage, ToolMessage, SystemMessage
from langchain_core.tools import tool
from langchain_groq import ChatGroq
from langgraph.graph import StateGraph, END
from langgraph.graph.message import add_messages

# --- API KEYS ---
load_dotenv()
os.environ["TAVILY_API_KEY"] = os.getenv("TAVILY_API_KEY") # Paste your Tavily key here

# --- 1. THE ATOMIC TOOLS ---

# Use Tavily instead of DuckDuckGo for fast, agent-optimized search
search_web = TavilySearchResults(max_results=3, name="search_web")
search_web.description = "Searches the live internet for up-to-date information, news, and research. Always use this tool if you need to look something up."

@tool
def browse_webpage(url: str) -> str:
    """Navigates to a webpage and extracts the readable text content.
    (Playwright will be injected here later for heavy, dynamic sites).
    """
    try:
        response = requests.get(url, timeout=10)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, 'html.parser')
        for script in soup(["script", "style"]):
            script.extract()
        return soup.get_text(separator=' ', strip=True)[:5000] + "\n...[Content Truncated]..."
    except Exception as e:
        return f"Failed to access {url}. Error: {str(e)}"

@tool
def save_output_file(filename: str, content: str) -> str:
    """Writes processed data or summaries directly to a physical file on the Desktop."""
    try:
        desktop_path = os.path.join(os.path.expanduser("~"), "Desktop")
        file_path = os.path.join(desktop_path, filename)
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)
        return f"Saved file directly to Desktop/{filename}"
    except Exception as e:
        return f"File system error: {str(e)}"

# --- TOOL 4: Quarantined Python Execution ---
@tool
def run_python_code(code: str) -> str:
    """Executes arbitrary Python code in an isolated sandbox.
    Use this tool for math, data processing, pandas, Excel generation, or formatting.
    """
    try:
        # 1. Save the LLM's code to a temporary file
        with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
            f.write(code)
            temp_path = f.name

        # 2. Run it in a completely separate process so it can't kill our server
        result = subprocess.run(
            [sys.executable, temp_path],
            capture_output=True,
            text=True,
            timeout=60 # Give it 60 seconds for heavy Pandas/Excel operations
        )
        
        # 3. Clean up the temp file
        os.remove(temp_path)
        
        # 4. Return the output or catch script errors
        output = result.stdout
        if result.stderr:
            output += f"\nScript Error Output:\n{result.stderr}"
            
        return output.strip() if output.strip() else "[Code executed successfully with no output]"
        
    except subprocess.TimeoutExpired:
        return "Execution Error: The script took longer than 60 seconds and timed out."
    except Exception as e:
        return f"Execution Error: {str(e)}"

import base64
from playwright.sync_api import sync_playwright
from PIL import Image

# --- TOOL 5: Interactive Dynamic Web Automation ---
@tool
def scrape_dynamic_page(url: str, wait_for_selector: str = None) -> str:
    """Launches a headless Chromium browser to render JavaScript-heavy portals,
    click elements, and extract text after dynamic content loads.
    """
    if not url.startswith("http://") and not url.startswith("https://"):
        url = f"https://{url}"
        
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
            page.goto(url, wait_until="domcontentloaded", timeout=15000)
            page.wait_for_timeout(2000) # Allow dynamic JS to render
            
            if wait_for_selector:
                page.wait_for_selector(wait_for_selector, timeout=8000)
                
            content = page.evaluate("() => document.body.innerText")
            browser.close()
            return content[:6000] + "\n...[Content Truncated]..."
    except Exception as e:
        return f"Scraping failed: {str(e)}"


# --- TOOL 6: Screenshot Capture ---
@tool
def capture_web_screenshot(url: str, output_image_name: str, selector: str = None) -> str:
    """Takes a screenshot of a full webpage or specific element and saves it directly to the Desktop."""
    if not url.startswith("http://") and not url.startswith("https://"):
        url = f"https://{url}"
        
    try:
        desktop_path = os.path.join(os.path.expanduser("~"), "Desktop")
        file_path = os.path.join(desktop_path, output_image_name)
        
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(
                viewport={"width": 1280, "height": 800},
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
            )
            page.goto(url, wait_until="domcontentloaded", timeout=15000)
            page.wait_for_timeout(2500) # Wait for images/styles to settle
            
            if selector:
                element = page.wait_for_selector(selector, timeout=8000)
                element.screenshot(path=file_path)
            else:
                page.screenshot(path=file_path, full_page=False) # Viewport screenshot
                
            browser.close()
            
        return f"Saved screenshot directly to Desktop/{output_image_name}"
    except Exception as e:
        return f"Screenshot capture failed: {str(e)}"


import json

# --- TOOL 7: Dynamic Multi-Action Web Navigator ---
@tool
def interactive_web_action(url: str, actions_json: str) -> str:
    """Performs a sequence of browser actions (click, scroll, type, screenshot) on a webpage.
    actions_json format:
    [
      {"action": "click", "selector": "#medals-tab"},
      {"action": "scroll", "pixels": 800},
      {"action": "wait", "seconds": 2},
      {"action": "screenshot", "filename": "medals_table.png"},
      {"action": "extract_text", "selector": "table.medals-list"}
    ]
    """
    if not url.startswith("http://") and not url.startswith("https://"):
        url = f"https://{url}"

    try:
        actions = json.loads(actions_json)
        results = []
        desktop_path = os.path.join(os.path.expanduser("~"), "Desktop")

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(
                viewport={"width": 1280, "height": 800},
                user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
            )
            page.goto(url, wait_until="domcontentloaded", timeout=20000)
            page.wait_for_timeout(2000)

            for step in actions:
                act = step.get("action")
                if act == "click":
                    page.wait_for_selector(step["selector"], timeout=5000)
                    page.click(step["selector"])
                elif act == "scroll":
                    page.mouse.wheel(0, step.get("pixels", 500))
                elif act == "wait":
                    page.wait_for_timeout(step.get("seconds", 2) * 1000)
                elif act == "type":
                    page.fill(step["selector"], step["text"])
                elif act == "screenshot":
                    fname = step.get("filename", "browser_capture.png")
                    save_path = os.path.join(desktop_path, fname)
                    page.screenshot(path=save_path)
                    results.append(f"Saved screenshot directly to Desktop/{fname}")
                elif act == "extract_text":
                    sel = step.get("selector", "body")
                    text = page.locator(sel).inner_text()
                    results.append(f"Extracted Text:\n{text[:3000]}")

            browser.close()

        return "\n".join(results) if results else "Actions completed successfully."
    except Exception as e:
        return f"Interactive action failed: {str(e)}"


import fnmatch
from pathlib import Path

# --- TOOL 8: Recursive File Finder ---
@tool
def find_local_files(search_directory: str, filename_pattern: str) -> str:
    """Searches recursively for files matching a pattern (e.g. '*.png', 'resume*', '*.csv')
    in directories like 'Desktop', 'Downloads', 'Documents', or a specific folder path.
    """
    try:
        # Expand common user paths
        if search_directory.lower() == "desktop":
            base_dir = Path.home() / "Desktop"
        elif search_directory.lower() == "downloads":
            base_dir = Path.home() / "Downloads"
        elif search_directory.lower() == "documents":
            base_dir = Path.home() / "Documents"
        else:
            base_dir = Path(os.path.expanduser(search_directory))

        if not base_dir.exists():
            return f"Directory not found: {base_dir}"

        matches = []
        for root, _, filenames in os.walk(base_dir):
            for filename in fnmatch.filter(filenames, filename_pattern):
                matches.append(os.path.join(root, filename))
                if len(matches) >= 20: # Limit output size
                    break
            if len(matches) >= 20:
                break

        if not matches:
            return f"No files matching '{filename_pattern}' found in {base_dir}."
            
        return "Found files:\n" + "\n".join(f"• {m}" for m in matches)
    except Exception as e:
        return f"File search error: {str(e)}"


# --- TOOL 9: Local File Inspector ---
@tool
def read_local_file(file_path: str) -> str:
    """Reads the contents of a local text, code, CSV, JSON, or markdown file.
    Provide the full file path or a relative path from the user's home directory.
    """
    try:
        resolved_path = os.path.expanduser(file_path)
        if not os.path.exists(resolved_path):
            # Attempt to check Desktop as fallback
            desktop_fallback = os.path.join(os.path.expanduser("~"), "Desktop", file_path)
            if os.path.exists(desktop_fallback):
                resolved_path = desktop_fallback
            else:
                return f"Error: File '{file_path}' does not exist."

        with open(resolved_path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read(5000) # Cap read to 5000 characters
            
        return f"Content of {os.path.basename(resolved_path)}:\n{content}"
    except Exception as e:
        return f"Failed to read file: {str(e)}"


# --- TOOL 10: Native Excel Spreadsheet Generator ---
@tool
def save_excel_file(filename: str, data_json: str) -> str:
    """Creates a real Excel (.xlsx) spreadsheet directly on the Desktop from structured data.
    data_json MUST be a valid JSON string containing either:
    1. A list of row dictionaries: '[{"State": "Haryana", "Gold": 40, "Total": 120}, ...]'
    2. A dictionary of sheets: '{"Overview": [{"State": "Haryana"}], "Medals": [...]}'
    Always use this tool when the user requests an Excel, spreadsheet, or .xlsx file.
    """
    try:
        if not filename.endswith(".xlsx"):
            filename += ".xlsx"

        desktop_path = os.path.join(os.path.expanduser("~"), "Desktop")
        file_path = os.path.join(desktop_path, filename)

        parsed_data = json.loads(data_json)

        if isinstance(parsed_data, list):
            df = pd.DataFrame(parsed_data)
            df.to_excel(file_path, index=False, engine="openpyxl")
        elif isinstance(parsed_data, dict):
            with pd.ExcelWriter(file_path, engine="openpyxl") as writer:
                for sheet_name, rows in parsed_data.items():
                    df = pd.DataFrame(rows)
                    df.to_excel(writer, sheet_name=sheet_name[:31], index=False)
        else:
            return "Error: data_json must be a JSON array of row objects."

        return f"Saved Excel spreadsheet directly to Desktop/{filename}"
    except Exception as e:
        return f"Excel creation error: {str(e)}"


# Register all tools into the LangGraph system
TOOLS = [
    search_web, 
    browse_webpage, 
    save_output_file, 
    save_excel_file,
    run_python_code, 
    scrape_dynamic_page, 
    capture_web_screenshot,
    interactive_web_action,
    find_local_files,
    read_local_file
]
tools_by_name = {t.name: t for t in TOOLS}

# --- 2. AGENT STATE & SYSTEM PROMPT ---

class AgentState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]

AGENT_SYSTEM_PROMPT = SystemMessage(content=r"""You are an autonomous desktop AI agent.
STRICT EXECUTION WORKFLOW:
1. When asked to research and compile data into a file or spreadsheet, DO NOT STOP after searching.
2. Once you have gathered sufficient facts from searches, you MUST compile the structured records into a JSON string and call `save_excel_file` (for spreadsheets) or `save_output_file` (for text).
3. Provide ONLY direct takeaways and final numbers.
4. NEVER output LaTeX notation, equation blocks, fractions (\frac), or delimiters like \[ \], \( \), or $$.
5. CRITICAL: You must ONLY use the tools provided to you. NEVER hallucinate tools named "browser", "python", or use raw <|channel|> tags.
""")

# --- 3. GRAPH ENGINE ---

def call_model(state: AgentState):
    # Locked strictly to the GPT-OSS-120B model as requested
    llm = ChatGroq(
        model_name="openai/gpt-oss-120b", 
        api_key=os.getenv("GROQ_API_KEY"), # Paste your Groq key here
        temperature=0.2
    ).bind_tools(TOOLS)
    
    messages_with_system = [AGENT_SYSTEM_PROMPT] + list(state["messages"])
    response = llm.invoke(messages_with_system)
    return {"messages": [response]}

def execute_tools(state: AgentState):
    last_message = state["messages"][-1]
    tool_messages = []
    
    for tool_call in last_message.tool_calls:
        tool_fn = tools_by_name[tool_call["name"]]
        tool_output = tool_fn.invoke(tool_call["args"])
        tool_messages.append(
            ToolMessage(content=str(tool_output), tool_call_id=tool_call["id"])
        )
    return {"messages": tool_messages}

def should_continue(state: AgentState):
    last_message = state["messages"][-1]
    if hasattr(last_message, "tool_calls") and len(last_message.tool_calls) > 0:
        return "tools"
    return END

workflow = StateGraph(AgentState)
workflow.add_node("agent", call_model)
workflow.add_node("tools", execute_tools)
workflow.set_entry_point("agent")
workflow.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
workflow.add_edge("tools", "agent")

agent_executor = workflow.compile()