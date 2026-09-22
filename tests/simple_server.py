#!/usr/bin/env python
"""
Simple server for demonstrating the RadSysX chat interface.
This provides a minimal server without dependencies on external packages.
"""

import os
import pathlib
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import uvicorn
import asyncio
import json
from typing import Optional, Dict, Any, List

# Import MCP tools functionality (mock import for now)
try:
    from backend.mcp import get_available_mcp_tools
except ImportError:
    # Mock function for demonstration
    def get_available_mcp_tools():
        """Mock function that returns available MCP tools."""
        class MockTool:
            def __init__(self, name, description, category):
                self.name = name
                self.description = description
                self.category = category
                
        return [
            MockTool("get_patient_demographics", "Get basic patient information", "fhir"),
            MockTool("get_medication_list", "Get a patient's medications", "fhir"),
            MockTool("search_fhir_resources", "Search for FHIR resources", "fhir"),
            MockTool("list_fhir_resources", "List available FHIR resources", "fhir"),
            MockTool("install_mcp_server", "Install a new MCP server", "system")
        ]

app = FastAPI(title="RadSysX Chat Demo")

# Define the path to frontend files
frontend_dir = pathlib.Path(__file__).resolve().parent.parent / "frontend"

# Mount static files serving
app.mount("/static", StaticFiles(directory=str(frontend_dir)), name="frontend")

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Define request models
class ChatRequest(BaseModel):
    message: str
    model_provider: Optional[str] = "openai"
    model_name: Optional[str] = None

class ToolRequest(BaseModel):
    tool_name: str
    params: Dict[str, Any]
    
class MCPToolRequest(BaseModel):
    tool_name: str
    params: Dict[str, Any]
    
class AgentToolRequest(BaseModel):
    agent_type: str
    tool_name: str
    params: Dict[str, Any]
    
class MCPToolsRequest(BaseModel):
    """Request to list MCP tools by category."""
    category: Optional[str] = None

# Mock async generator for the chat stream
async def mock_stream_chat(message):
    """Simulate streaming responses for demonstration purposes."""
    # Initial response delay
    await asyncio.sleep(0.5)
    
    # Detect if this is a help request
    if message.strip() in ["/help", "/tools", "/?" , "/?"]:  
        help_text = "RadSysX Chat Interface Help\n\n"
        
        help_text += "## DIRECT MCP ACCESS\n"
        help_text += "Access MCP tools directly with:\n"
        help_text += "/mcp tool_name param1=value1 param2=value2\n"
        help_text += "Shorthand: /m tool_name param1=value1 param2=value2\n\n"
        help_text += "List available MCP tools: /mcp-list\n\n"
        
        help_text += "## SPECIALIZED AGENTS\n"
        help_text += "Each agent can access specialized MCP tools:\n"
        help_text += "- /ask pharmacist <question>: Consult our pharmacist agent about medications\n"
        help_text += "- /ask researcher <question>: Consult our medical researcher about studies\n"
        help_text += "- /ask medical_analyst <question>: Consult our medical analyst about diagnoses\n\n"
        
        help_text += "## AGENT-SPECIFIC MCP TOOLS\n"
        help_text += "Each agent has access to specialized MCP tools:\n"
        help_text += "- View agent tools: /agent-tools pharmacist\n"
        help_text += "- Use agent tool: /agent-mcp pharmacist get_medication_list patient_id=12345\n\n"
        
        help_text += "## STANDARD TOOLS\n"
        help_text += "Original tool commands (maintained for compatibility):\n"
        help_text += "- /tool tool_name param1=value1 param2=value2\n"
        help_text += "- /t tool_name param1=value1 param2=value2\n\n"
        
        help_text += "## FHIR TOOLS\n"
        help_text += "- list_fhir_resources: List available FHIR resources\n"
        help_text += "- get_patient_demographics: Get basic patient information\n"
        help_text += "- get_medication_list: Get a patient's medications\n\n"
        
        help_text += "## SYSTEM TOOLS\n"
        help_text += "- install_mcp_server: Install additional MCP servers\n\n"
        
        # Yield the help text in chunks
        for i in range(0, len(help_text), 20):
            yield help_text[i:i+20]
            await asyncio.sleep(0.05)
        return
    
    # Handle direct MCP command
    if message.startswith("/mcp ") or message.startswith("/m "):
        # Remove prefix
        cmd = message[5:] if message.startswith("/mcp ") else message[3:]
        
        # Parse command format: /mcp tool_name param1=value1 param2=value2
        parts = cmd.strip().split()
        if not parts:
            yield "Error: MCP tool name not specified. Use format: /mcp tool_name param1=value1"
            return
        
        tool_name = parts[0]
        params = {}
        
        # Parse parameters
        for param in parts[1:]:
            if "=" in param:
                key, value = param.split("=", 1)
                params[key] = value
        
        # Get available tools
        mcp_tools = get_available_mcp_tools()
        
        # Find the tool
        tool_found = False
        for tool in mcp_tools:
            if tool.name == tool_name:
                tool_found = True
                break
        
        if not tool_found:
            yield f"Error: MCP tool '{tool_name}' not found. Use /mcp-list to see available tools."
            return
        
        # Simulate tool execution
        yield f"Executing MCP tool: {tool_name}...\n"
        await asyncio.sleep(1.0)
        
        # Mock response
        mock_result = f"[This is a simulated response from the {tool_name} MCP tool. Parameters: {params}]\n\nIn a real environment, this would show actual data from the tool."
        yield mock_result
        return
    
    # Handle MCP tools listing
    if message.strip() in ["/mcp-list", "/mcp-tools", "/m-list"]:
        yield "Available MCP Tools:\n\n"
        
        # Get the tools
        mcp_tools = get_available_mcp_tools()
        
        # Group tools by category
        tool_categories = {}
        for tool in mcp_tools:
            category = getattr(tool, "category", "general")
            if category not in tool_categories:
                tool_categories[category] = []
            tool_categories[category].append(tool)
        
        # Format and yield the tool list
        for category, tools in tool_categories.items():
            yield f"## {category.upper()} TOOLS\n"
            for tool in tools:
                yield f"- {tool.name}: {tool.description}\n"
            yield "\n"
            await asyncio.sleep(0.2)  # Brief delay between categories
        
        # Add usage examples
        yield "\nExample usage:\n"
        yield "/mcp get_patient_demographics patient_id=12345\n"
        yield "/mcp search_fhir_resources query=Patient?name=Smith\n"
        return
    
    # Handle agent-specific tools request
    if message.startswith("/agent-tools "):
        parts = message[13:].strip().split()
        if not parts:
            yield "Error: Agent type not specified. Use format: /agent-tools agent_type"
            return
        
        agent_type = parts[0].lower()
        if agent_type not in ["pharmacist", "researcher", "medical_analyst"]:
            yield f"Error: Unknown agent type '{agent_type}'. Available agents: pharmacist, researcher, medical_analyst"
            return
        
        # Define tool mapping for each agent type
        agent_tools = {
            "pharmacist": [
                {"name": "get_medication_list", "description": "Get a patient's medications"},
                {"name": "search_fhir_resources", "description": "Search for FHIR resources"}
            ],
            "researcher": [
                {"name": "search_fhir_resources", "description": "Search for FHIR resources"},
                {"name": "list_fhir_resources", "description": "List available FHIR resources"}
            ],
            "medical_analyst": [
                {"name": "get_patient_demographics", "description": "Get patient demographics"},
                {"name": "get_medication_list", "description": "Get a patient's medications"},
                {"name": "search_fhir_resources", "description": "Search for FHIR resources"}
            ]
        }
        
        yield f"MCP Tools available to {agent_type} agent:\n\n"
        for tool in agent_tools.get(agent_type, []):
            yield f"- {tool['name']}: {tool['description']}\n"
        
        yield f"\nUse with: /agent-mcp {agent_type} tool_name param1=value1 param2=value2"
        return
    
    # Handle agent-specific MCP tool execution
    if message.startswith("/agent-mcp "):
        parts = message[11:].strip().split()
        if len(parts) < 2:
            yield "Error: Insufficient parameters. Use format: /agent-mcp agent_type tool_name param1=value1"
            return
        
        agent_type = parts[0].lower()
        tool_name = parts[1]
        params = {}
        
        # Parse parameters
        for param in parts[2:]:
            if "=" in param:
                key, value = param.split("=", 1)
                params[key] = value
        
        # Validate agent type
        if agent_type not in ["pharmacist", "researcher", "medical_analyst"]:
            yield f"Error: Unknown agent type '{agent_type}'. Available agents: pharmacist, researcher, medical_analyst"
            return
        
        # For simulation, check if the tool is appropriate for this agent
        agent_tools = {
            "pharmacist": ["get_medication_list", "search_fhir_resources"],
            "researcher": ["search_fhir_resources", "list_fhir_resources"],
            "medical_analyst": ["get_patient_demographics", "get_medication_list", "search_fhir_resources"],
        }
        
        if tool_name not in agent_tools.get(agent_type, []):
            yield f"Error: Tool '{tool_name}' is not available to the {agent_type} agent"
            return
        
        # Execute the agent-specific tool
        yield f"Executing MCP tool '{tool_name}' through {agent_type} agent...\n"
        await asyncio.sleep(1.0)
        
        # Format the response with agent-specific thinking process
        thinking = f"<think>\nAnalyzing request to execute tool '{tool_name}' with parameters {params}\n"
        thinking += f"Validating parameters and preparing data for the {agent_type}'s analysis...\n</think>\n\n"
        
        # Add agent signature
        signature = "Pharmacist" if agent_type == "pharmacist" else "Researcher" if agent_type == "researcher" else "Medical Analyst"
        
        yield f"{thinking}{signature}: Based on the {tool_name} data:\n[This is a simulated response for the {tool_name} tool executed by the {agent_type} agent. Parameters: {params}]\n\nIn a real environment, this would execute the actual MCP tool through the specialized agent."
        return
        
    # Handle agent queries
    if message.lower().startswith("/ask "):
        parts = message[5:].strip().split(" ", 1)
        if len(parts) >= 2:
            agent_type = parts[0].lower()
            query = parts[1]
            
            # Simulate agent response based on type
            if agent_type in ["pharmacist", "researcher", "medical_analyst"]:
                # Initial response
                yield f"Consulting {agent_type.replace('_', ' ').title()} agent...\n\n"
                await asyncio.sleep(0.5)
                
                # Mock thinking process
                thinking = f"<think>\nAnalyzing the query: '{query}'\n\n"
                if agent_type == "pharmacist":
                    thinking += "1. Considering medication interactions\n"
                    thinking += "2. Checking dosage recommendations\n"
                    thinking += "3. Evaluating side effect profiles\n"
                elif agent_type == "researcher":
                    thinking += "1. Searching for relevant clinical trials\n"
                    thinking += "2. Evaluating evidence quality\n"
                    thinking += "3. Comparing research methodologies\n"
                else:  # medical_analyst
                    thinking += "1. Analyzing symptom patterns\n"
                    thinking += "2. Considering diagnostic criteria\n"
                    thinking += "3. Evaluating treatment efficacy\n"
                thinking += "</think>\n\n"
                
                # Stream the thinking process
                for i in range(0, len(thinking), 10):
                    yield thinking[i:i+10]
                    await asyncio.sleep(0.03)
                
                # Mock response based on agent type
                response = ""
                if agent_type == "pharmacist":
                    response = f"Pharmacist: Based on my analysis, {query.strip('?')}. I would recommend consulting with your healthcare provider for personalized advice."
                elif agent_type == "researcher":
                    response = f"Researcher: The current research on {query.strip('?')} suggests varying outcomes. The most recent studies indicate promising results, but more research is needed."
                else:  # medical_analyst
                    response = f"Medical Analyst: After analyzing the information about {query.strip('?')}, I would suggest considering multiple factors including patient history and current symptoms before making a determination."
                
                # Stream the response
                for i in range(0, len(response), 15):
                    yield response[i:i+15]
                    await asyncio.sleep(0.04)
                    
                return
    
    # Handle tool execution
    if message.startswith("/tool ") or message.startswith("/t "):
        # Extract tool name
        cmd = message[6:] if message.startswith("/tool ") else message[3:]
        parts = cmd.strip().split()
        
        if not parts:
            yield "Error: Tool name not specified. Use format: /tool tool_name param1=value1"
            return
            
        tool_name = parts[0]
        yield f"Executing tool: {tool_name}...\n"
        await asyncio.sleep(0.5)
        
        # Mock tool execution response
        yield f"\n\nResult:\n"
        await asyncio.sleep(0.3)
        yield f"[This is a simulated response for the {tool_name} tool. In a real environment, this would execute the actual MCP tool.]"
        return
    
    # Default response for regular messages
    welcome_msg = "Welcome to RadSysX Chat! I'm here to help with your medical research queries.\n\n"
    for char in welcome_msg:
        yield char
        await asyncio.sleep(0.01)
        
    response = f"You said: {message}\n\nThis is a simulated response. In a real environment, this would be processed by the LLM.\n\nTry using commands like /help, /ask pharmacist, or /tool list_fhir_resources to see more functionality."
    
    for i in range(0, len(response), 10):
        yield response[i:i+10]
        await asyncio.sleep(0.02)

# Chat endpoint
@app.post("/chat")
async def chat(request: ChatRequest):
    """API endpoint for direct chat with LLM."""
    try:
        # For demo, just accumulate the whole mock response
        full_response = ""
        async for chunk in mock_stream_chat(request.message):
            full_response += chunk
        return {"response": full_response}
    except Exception as e:
        print("Error in chat. Please try again later.")
        return {"error": "Error processing chat. Please try again later."}

# Chat streaming endpoint
@app.post("/chat/stream")
async def chat_stream(request: ChatRequest):
    """API endpoint to stream chat responses as they become available."""
    try:
        async def event_generator():
            # Use our mock streaming function
            async for chunk in mock_stream_chat(request.message):
                if chunk:
                    # Format as a Server-Sent Event
                    yield f"data: {json.dumps({'chunk': chunk})}\n\n"
                    
            # Signal end of stream
            yield f"data: {json.dumps({'done': True})}\n\n"
        
        # Return a streaming response with the SSE media type
        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream"
        )
    except Exception as e:
        print("Error in chat stream. Please try again later.")
        return {"error": "Error streaming chat. Please try again later."}

# List available tools
@app.get("/tools")
async def list_tools():
    """API endpoint to list all available tools."""
    try:
        # Get MCP tools dynamically from the imported function
        mcp_tools = get_available_mcp_tools()
        formatted_tools = []
        
        for tool in mcp_tools:
            formatted_tools.append({
                "name": tool.name,
                "description": tool.description,
                "type": "mcp",
                "category": getattr(tool, "category", "general")
            })
            
        return {"tools": formatted_tools}
    except Exception as e:
        print("Error listing tools. Please try again later.")
        return {"error": "Error listing tools. Please try again later."}

# Tool execution endpoint
@app.post("/tools/execute")
async def execute_tool(request: ToolRequest):
    """API endpoint to execute an MCP tool directly."""
    try:
        # Mock tool execution response
        return {
            "result": f"[This is a simulated response for the {request.tool_name} tool. Parameters: {request.params}]\n\nIn a real environment, this would execute the actual MCP tool."
        }
    except Exception as e:
        print("Error executing tool. Please try again later.")
        return {"error": "Error executing tool. Please try again later."}
        
# Agent tool execution endpoint
@app.post("/agent/{agent_type}/tools/execute")
async def execute_agent_tool(agent_type: str, request: ToolRequest):
    """API endpoint to execute an MCP tool through a specialized agent."""
    try:
        # Validate agent type
        if agent_type not in ["pharmacist", "researcher", "medical_analyst"]:
            return {"error": f"Unknown agent type: {agent_type}"}
            
        # For simulation, we'll check if the tool is appropriate for this agent
        agent_tools = {
            "pharmacist": ["get_medication_list", "search_fhir_resources"],
            "researcher": ["search_fhir_resources", "list_fhir_resources"],
            "medical_analyst": ["get_patient_demographics", "get_medication_list", "search_fhir_resources"],
        }
        
        if request.tool_name not in agent_tools.get(agent_type, []):
            return {"error": f"Tool '{request.tool_name}' is not available to the {agent_type} agent"}
        
        # Mock execution result with thinking process
        thinking = f"<think>\nAnalyzing request to execute tool '{request.tool_name}' with parameters {request.params}\n"
        thinking += f"Validating parameters and preparing data for the {agent_type}'s analysis...\n</think>\n\n"
        
        result = f"{thinking}[This is a simulated response for the {request.tool_name} tool executed by the {agent_type} agent. Parameters: {request.params}]\n\nIn a real environment, this would execute the actual MCP tool through the specialized agent."
        return {"result": result}
    except Exception as e:
        print("Error executing agent tool. Please try again later.")
        return {"error": "Error executing agent tool. Please try again later."}

# List agent tools endpoint
@app.get("/agent/{agent_type}/tools")
async def list_agent_tools(agent_type: str):
    """List the tools available to a specific agent."""
    try:
        # Validate agent type
        if agent_type not in ["pharmacist", "researcher", "medical_analyst"]:
            return {"error": f"Unknown agent type: {agent_type}"}
            
        # Define tool mapping for each agent type (same as in the full implementation)
        agent_tools = {
            "pharmacist": [
                {"name": "get_medication_list", "description": "Get a patient's medications", "type": "mcp", "category": "fhir"},
                {"name": "search_fhir_resources", "description": "Search for FHIR resources", "type": "mcp", "category": "fhir"}
            ],
            "researcher": [
                {"name": "search_fhir_resources", "description": "Search for FHIR resources", "type": "mcp", "category": "fhir"},
                {"name": "list_fhir_resources", "description": "List available FHIR resources", "type": "mcp", "category": "fhir"}
            ],
            "medical_analyst": [
                {"name": "get_patient_demographics", "description": "Get patient demographics", "type": "mcp", "category": "fhir"},
                {"name": "get_medication_list", "description": "Get a patient's medications", "type": "mcp", "category": "fhir"},
                {"name": "search_fhir_resources", "description": "Search for FHIR resources", "type": "mcp", "category": "fhir"}
            ]
        }
        
        return {"tools": agent_tools.get(agent_type, [])}
    except Exception as e:
        print("Error listing agent tools. Please try again later.")
        return {"error": "Error listing agent tools. Please try again later."}

# Serve the chat UI
@app.get("/", response_class=HTMLResponse)
async def serve_chat_ui():
    try:
        # Read the HTML file
        chat_ui_path = frontend_dir / "chat_ui.html"
        with open(chat_ui_path, "r") as f:
            html_content = f.read()
        return HTMLResponse(content=html_content)
    except Exception as e:
        print("Error serving chat UI. Please try again later.")
        return HTMLResponse(content="<h1>Error loading chat UI</h1>")

# Direct MCP tools listing endpoint
@app.get("/mcp/tools")
async def list_mcp_tools(request: Optional[MCPToolsRequest] = None):
    """API endpoint to list all available MCP tools, optionally filtered by category."""
    try:
        # Get MCP tools
        mcp_tools = get_available_mcp_tools()
        category_filter = request.category if request and request.category else None
        
        # Format the tools for the response
        formatted_tools = []
        for tool in mcp_tools:
            tool_category = getattr(tool, "category", "general")
            
            # Apply category filter if specified
            if category_filter and tool_category != category_filter:
                continue
                
            formatted_tools.append({
                "name": tool.name,
                "description": tool.description,
                "category": tool_category,
                "parameters": getattr(tool, "parameters", {})
            })
        
        # Group tools by category
        categories = {}
        for tool in formatted_tools:
            category = tool.get("category")
            if category not in categories:
                categories[category] = []
            categories[category].append(tool)
        
        return {
            "tools": formatted_tools,
            "categories": categories
        }
    except Exception as e:
        print("Error listing MCP tools. Please try again later.")
        return {"error": "Error listing MCP tools. Please try again later."}


# Direct MCP tool execution endpoint
@app.post("/mcp/execute")
async def execute_mcp_tool(request: MCPToolRequest):
    """API endpoint to execute an MCP tool directly."""
    try:
        # Get the available tools
        mcp_tools = get_available_mcp_tools()
        
        # Find the requested tool
        tool = None
        for t in mcp_tools:
            if t.name == request.tool_name:
                tool = t
                break
                
        if not tool:
            return {"error": f"MCP tool '{request.tool_name}' not found"}
        
        # In a real implementation, we would execute the tool here
        # For now, we'll just generate a mock response
        mock_response = f"[This is a simulated response for direct execution of the {request.tool_name} MCP tool. Parameters: {request.params}]\n\nIn a real environment, this would execute the actual MCP tool."
        
        return {"result": mock_response}
    except Exception as e:
        print("Error executing MCP tool. Please try again later.")
        return {"error": "Error executing MCP tool. Please try again later."}


if __name__ == "__main__":
    # Try a different port to avoid conflicts
    uvicorn.run(app, host="0.0.0.0", port=8765)
