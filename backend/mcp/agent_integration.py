"""
Integration between LangChain agents and MCP functionality.

This module provides the MCPToolkit class that creates LangChain-compatible
tools for accessing FHIR data. Tools are passed directly to deepagents
subagent configs rather than monkey-patched onto agents.
"""

import json
import logging
from typing import List, Optional
from langchain_core.tools import Tool

from .client import RadSysXMCPClient


def get_client():
    """Get the default MCP client."""
    return RadSysXMCPClient()


logger = logging.getLogger(__name__)

class MCPToolkit:
    """
    A toolkit that provides MCP-powered tools for LangChain agents.
    
    This class creates LangChain-compatible tools that invoke MCP
    server capabilities, allowing agents to seamlessly access FHIR
    resources and other MCP functionality.
    """
    
    def __init__(self, client: Optional[RadSysXMCPClient] = None):
        """
        Initialize the MCP toolkit.
        
        Args:
            client: An optional RadSysXMCPClient instance. If not provided,
                   the default client will be used.
        """
        self.client = client or get_client()
        
    async def _list_fhir_resources(self, args: str) -> str:
        """List available FHIR resources."""
        try:
            resources = await self.client.list_resources()
            return json.dumps(resources, indent=2)
        except Exception as e:
            logger.error(f"Error listing FHIR resources: {e}")
            return f"Error listing FHIR resources: {str(e)}"
    
    async def _get_patient_demographics(self, patient_id: str) -> str:
        """Get demographics for a specific patient."""
        try:
            demographics = await self.client.get_patient_demographics(patient_id)
            return json.dumps(demographics, indent=2)
        except Exception as e:
            logger.error(f"Error getting patient demographics: {e}")
            return f"Error getting patient demographics: {str(e)}"
    
    async def _get_medication_list(self, patient_id: str) -> str:
        """Get medication list for a specific patient."""
        try:
            medications = await self.client.get_medication_list(patient_id)
            return json.dumps(medications, indent=2)
        except Exception as e:
            logger.error(f"Error getting medication list: {e}")
            return f"Error getting medication list: {str(e)}"
    
    async def _search_fhir_resources(self, query: str) -> str:
        """Search FHIR resources based on a query."""
        try:
            # Parse the query which should be in format "ResourceType?param=value"
            parts = query.strip().split("?", 1)
            if len(parts) != 2:
                return "Invalid query format. Use 'ResourceType?param=value'"
            
            resource_type = parts[0]
            params = parts[1]
            
            # Convert to dictionary of parameters
            param_dict = {}
            for param_pair in params.split("&"):
                if "=" in param_pair:
                    key, value = param_pair.split("=", 1)
                    param_dict[key] = value
            
            results = await self.client.search_fhir_resources(resource_type, param_dict)
            return json.dumps(results, indent=2)
        except Exception as e:
            logger.error(f"Error searching FHIR resources: {e}")
            return f"Error searching FHIR resources: {str(e)}"
    
    def get_tools(self) -> List[Tool]:
        """
        Get a list of LangChain tools that can be added to an agent.
        
        Returns:
            A list of LangChain Tool objects that invoke MCP functionality.
        """
        return [
            Tool(
                name="list_fhir_resources",
                description="Lists all available FHIR resources that can be accessed",
                func=self._list_fhir_resources,
                coroutine=self._list_fhir_resources,
            ),
            Tool(
                name="get_patient_demographics",
                description="Get demographics for a patient. Input should be a patient ID.",
                func=self._get_patient_demographics,
                coroutine=self._get_patient_demographics,
            ),
            Tool(
                name="get_medication_list",
                description="Get medication list for a patient. Input should be a patient ID.",
                func=self._get_medication_list,
                coroutine=self._get_medication_list,
            ),
            Tool(
                name="search_fhir_resources",
                description=(
                    "Search FHIR resources. Input should be in format 'ResourceType?param=value'. "
                    "Example: 'Patient?name=Smith' or 'Medication?code=123456'"
                ),
                func=self._search_fhir_resources,
                coroutine=self._search_fhir_resources,
            ),
        ]
