# RadSysX MCP Integration

This module provides integration between the RadSysX framework and Model Context Protocol (MCP) servers, with a specific focus on FHIR healthcare data access.

## Overview

The MCP integration allows RadSysX's agents to access and interact with healthcare data through a standardized protocol. The implementation includes:

1. **FHIR MCP Server**: A server that exposes FHIR resources and operations as MCP tools
2. **MCP Client**: A client that connects to MCP servers and provides a simple API to interact with them
3. **Agent Integration**: Utilities to enhance LangChain agents with MCP capabilities

## Components

### FHIR MCP Server (`fhir_server.py`)

The FHIR MCP Server provides access to FHIR resources through the Model Context Protocol. It supports:

- Listing available FHIR resources
- Reading specific resources by ID
- Searching for resources with parameters
- Specialized tools for common healthcare operations:
  - Getting patient demographics
  - Retrieving medication lists
  - Searching for medications

### MCP Client (`client.py`)

The MCP Client provides a simple interface to connect to and interact with MCP servers. It includes:

- Connecting to MCP servers
- Listing available resources
- Reading resources
- Calling tools
- Convenience methods for FHIR operations

### Agent Integration (`agent_integration.py`)

This module enables LangGraph agents to use MCP capabilities through a toolkit approach:

- `MCPToolkit`: Provides LangGraph-compatible tools that invoke MCP server capabilities
- `enhance_agent_with_mcp()`: Function to add MCP tools to existing LangGraph agents

## Environment Variables

The MCP integration requires the following environment variables:

- `FHIR_BASE_URL`: The base URL for the FHIR server (e.g., `https://hapi.fhir.org/baseR4`)
- `FHIR_ACCESS_TOKEN`: An access token for authentication with the FHIR server (if required)

## Usage

### Basic Client Usage

```python
from mcp.client import get_client

# Get the default client
client = get_client()

# Connect to a FHIR MCP server
await client.connect(fhir_server)

# List available resources
resources = await client.list_resources()

# Get patient demographics
demographics = await client.get_patient_demographics("patient-123")

# Search for medications
medications = await client.search_fhir_resources("Medication", {"code": "123456"})
```

### Enhancing Agents with MCP

```python
from langchain.agents import Agent
from mcp.agent_integration import enhance_agent_with_mcp

# Create your LangChain agent
agent = create_react_agent(...)

# Enhance it with MCP capabilities
enhanced_agent = enhance_agent_with_mcp(agent)

# You can also selectively include specific MCP tools
enhanced_agent = enhance_agent_with_mcp(
    agent, 
    include_tools=["get_patient_demographics", "get_medication_list"]
)
```

### Enabling/Disabling MCP in RadSysX

The RadSysX framework includes a function to enable or disable MCP integration:

```python
import radsysx

# Enable MCP integration for all agents
radsysx.enable_disable_mcp(True)

# Disable MCP integration
radsysx.enable_disable_mcp(False)
```

## Testing

Use the `test_mcp_integration.py` script to test the MCP integration:

```bash
# Test everything
python test_mcp_integration.py

# Test specific components
python test_mcp_integration.py --mode server
python test_mcp_integration.py --mode client
python test_mcp_integration.py --mode agent

# Test with a custom query
python test_mcp_integration.py --mode agent --query "What medications are recommended for diabetes?"
```
