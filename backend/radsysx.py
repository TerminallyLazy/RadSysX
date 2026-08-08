"""RadSysX multi-agent medical research system built on deepagents.

Uses a supervisor deep agent that delegates to specialist subagents
(pharmacist, researcher, medical_analyst) via the built-in task tool.
"""

from typing import AsyncGenerator, List

from deepagents import create_deep_agent
from deepagents.backends import FilesystemBackend
from langchain_openai import ChatOpenAI
from langgraph.types import Overwrite

from tools.medications import get_drug_use_cases, search_drugs_for_condition
from tools.medical_info import search_wikem
from tools.researcher import (
    search_pubmed,
    fetch_pubmed_details,
    get_pubmed_identifiers,
    get_pmc_link,
    retrieve_article_text,
)
from mcp.agent_integration import MCPToolkit

from dotenv import load_dotenv
import json
import asyncio
import os
import pathlib
import re

load_dotenv(dotenv_path="../.env.local")

# Set up MCP-related environment variables if not already set
if not os.getenv("FHIR_BASE_URL"):
    os.environ["FHIR_BASE_URL"] = os.getenv("FHIR_BASE_URL", "https://hapi.fhir.org/baseR4")
if not os.getenv("FHIR_ACCESS_TOKEN"):
    os.environ["FHIR_ACCESS_TOKEN"] = os.getenv("FHIR_ACCESS_TOKEN", "")

# Backend directory (where skills live)
BACKEND_DIR = pathlib.Path(__file__).parent

llm = ChatOpenAI(model="gpt-4o-mini")

# MCP toolkit for FHIR tools
mcp_toolkit = MCPToolkit()

# Track MCP state
_mcp_enabled = True

# --------------------------------------------------------------------------- #
#  Tool sets per specialist
# --------------------------------------------------------------------------- #

PHARMACIST_TOOLS = [get_drug_use_cases, search_drugs_for_condition]
RESEARCHER_TOOLS = [
    search_pubmed,
    fetch_pubmed_details,
    get_pubmed_identifiers,
    get_pmc_link,
    retrieve_article_text,
]
MEDICAL_ANALYST_TOOLS = [search_wikem]


def _get_mcp_tools(include: list[str] | None = None) -> list:
    """Get MCP tools, optionally filtered by name."""
    all_tools = mcp_toolkit.get_tools()
    if include is None:
        return all_tools
    return [t for t in all_tools if t.name in include]


# --------------------------------------------------------------------------- #
#  Subagent system prompts (domain knowledge from skills, kept concise)
# --------------------------------------------------------------------------- #

PHARMACIST_PROMPT = """\
You are a pharmacist agent that helps find information about medications, \
their uses, and appropriate treatments.

Before providing your final answer, you MUST include your detailed reasoning \
process enclosed in <think></think> tags. This reasoning should include:
- Your analysis of the medication request
- Potential drug interactions or contraindications you've considered
- Why you've selected certain medications over others
- Any other relevant pharmacological considerations

After your <think></think> section, provide your clear, concise final \
recommendation."""

RESEARCHER_PROMPT = """\
You are a medical researcher agent that helps find and analyze scientific \
literature and research papers.

Before providing your final answer, you MUST include your detailed reasoning \
process enclosed in <think></think> tags. This reasoning should include:
- Your search strategy and why you chose specific search terms
- How you evaluated the quality and relevance of the research
- Your process for synthesizing information from multiple sources
- Any limitations or gaps in the research you identified

After your <think></think> section, provide your clear, evidence-based \
conclusion with proper citations.

When including PubMed references, always format as direct URLs:
- Article: https://pubmed.ncbi.nlm.nih.gov/{PMID}/
- Full text: https://pmc.ncbi.nlm.nih.gov/articles/{PMCID}/"""

MEDICAL_ANALYST_PROMPT = """\
You are a medical analyst agent that helps analyze medical conditions, \
diagnoses, and treatment options.

Before providing your final answer, you MUST include your detailed reasoning \
process enclosed in <think></think> tags. This reasoning should include:
- Your differential diagnosis process
- How you ruled out alternative conditions
- Your analysis of symptoms and clinical presentation
- How you determined the most appropriate treatment approach

After your <think></think> section, provide your clear clinical assessment \
and recommendations."""

SUPERVISOR_PROMPT = """\
You are a medical research supervisor managing three specialist agents:

1. **pharmacist** — medication queries, drug interactions, prescriptions, \
finding drugs for conditions
2. **researcher** — PubMed literature search, clinical evidence, research papers
3. **medical_analyst** — diagnosis, differential diagnosis, treatment options, \
emergency medicine (uses WikEM)

For each user query, delegate to the most appropriate specialist using the \
task tool. You may delegate to multiple specialists if the query spans domains. \
Synthesize their responses into a cohesive answer for the user.

Always ensure specialists use chain-of-thought reasoning (<think></think> tags) \
for medical transparency."""


# --------------------------------------------------------------------------- #
#  Graph construction
# --------------------------------------------------------------------------- #

def _build_subagents() -> list[dict]:
    """Build subagent configs, including MCP tools when enabled."""
    mcp_tools_all = _get_mcp_tools() if _mcp_enabled else []
    mcp_tools_meds = _get_mcp_tools(["get_medication_list", "search_fhir_resources"]) if _mcp_enabled else []
    mcp_tools_research = _get_mcp_tools(["list_fhir_resources", "search_fhir_resources"]) if _mcp_enabled else []

    return [
        {
            "name": "pharmacist",
            "description": (
                "Pharmaceutical specialist for medication queries, drug interactions, "
                "prescriptions, and finding medications for conditions."
            ),
            "system_prompt": PHARMACIST_PROMPT,
            "tools": PHARMACIST_TOOLS + mcp_tools_meds,
            "model": llm,
        },
        {
            "name": "researcher",
            "description": (
                "Medical research specialist for PubMed literature search, clinical "
                "evidence, research papers, and scientific analysis."
            ),
            "system_prompt": RESEARCHER_PROMPT,
            "tools": RESEARCHER_TOOLS + mcp_tools_research,
            "model": llm,
        },
        {
            "name": "medical_analyst",
            "description": (
                "Medical analysis specialist for diagnosis, differential diagnosis, "
                "treatment options, emergency medicine, and clinical assessment."
            ),
            "system_prompt": MEDICAL_ANALYST_PROMPT,
            "tools": MEDICAL_ANALYST_TOOLS + mcp_tools_all,
            "model": llm,
        },
    ]


def _create_graph():
    """Create (or recreate) the deep agent graph."""
    backend = FilesystemBackend(root_dir=str(BACKEND_DIR))

    return create_deep_agent(
        model=llm,
        system_prompt=SUPERVISOR_PROMPT,
        subagents=_build_subagents(),
        skills=["skills/"],
        backend=backend,
        name="radsysx_supervisor",
    )


# Build the initial graph
graph = _create_graph()


# --------------------------------------------------------------------------- #
#  Public API — same signatures as the old module
# --------------------------------------------------------------------------- #

def enable_disable_mcp(enabled: bool = True) -> str:
    """Enable or disable MCP integration for all agents.

    Args:
        enabled: If True, MCP tools will be enabled. If False, they will be disabled.

    Returns:
        A message indicating the current state of MCP integration.
    """
    global graph, _mcp_enabled
    _mcp_enabled = enabled
    graph = _create_graph()

    if enabled:
        return "MCP integration enabled for all agents."
    return "MCP integration disabled for all agents."


def process_query(query: str) -> List[str]:
    """Process user query using the deep agent and extract responses."""
    results = []
    agent_responses = {}

    for event in graph.stream(
        {"messages": [{"role": "user", "content": query}]},
        stream_mode="updates",
    ):
        for node_name, node_data in event.items():
            if node_data is None:
                continue
            messages = node_data.get("messages", [])
            # Unwrap Overwrite if deepagents/langgraph returns one
            if isinstance(messages, Overwrite):
                messages = messages.value
            if not isinstance(messages, list):
                messages = [messages] if messages else []
            for message in messages:
                # Extract content from AI/tool messages
                content = None
                agent_name = node_name

                if hasattr(message, "content") and message.content:
                    content = message.content
                    if hasattr(message, "name") and message.name:
                        agent_name = message.name
                elif isinstance(message, dict) and message.get("content"):
                    content = message["content"]
                    agent_name = message.get("name", node_name)

                if not content or agent_name in ("user", "human"):
                    continue
                # Skip middleware echo nodes that just repeat user input
                if "middleware" in node_name.lower():
                    continue

                # Sanitize agent name
                agent_name = re.sub(r"[^a-zA-Z0-9_-]", "_", str(agent_name))

                if agent_name not in agent_responses:
                    agent_responses[agent_name] = []
                agent_responses[agent_name].append(content)

                formatted = f"## {agent_name.capitalize()} Response:\n{content}"
                results.append(formatted)
                print(f"Added message from {agent_name}: {content[:100]}...")

    # Debug summary
    print("\n----- AGENT RESPONSE SUMMARY -----")
    for agent, msgs in agent_responses.items():
        print(f"Agent: {agent} - {len(msgs)} messages")
        for i, msg in enumerate(msgs):
            print(f"  Message {i+1}: {len(msg)} chars")
    print("----- END SUMMARY -----\n")

    if not results:
        return ["I couldn't process your query. Please try again with a different question."]

    print(f"Final results count: {len(results)}")
    for i, result in enumerate(results):
        print(f"Result {i+1} length: {len(result)} chars")
        print(f"Result {i+1} preview: {result[:100]}...")

    return results


async def stream_query(query: str) -> AsyncGenerator[str, None]:
    """Stream user query responses as they become available.

    Yields JSON strings with {"chunk": "...", "agent": "..."} structure,
    matching the format expected by server.py.
    """
    print(f"Starting stream_query with query: {query}")

    agent_responses = {}
    responded_agents = set()

    for event in graph.stream(
        {"messages": [{"role": "user", "content": query}]},
        stream_mode="updates",
    ):
        for node_name, node_data in event.items():
            if node_data is None:
                continue
            messages = node_data.get("messages", [])
            # Unwrap Overwrite if deepagents/langgraph returns one
            if isinstance(messages, Overwrite):
                messages = messages.value
            if not isinstance(messages, list):
                messages = [messages] if messages else []
            for message in messages:
                content = None
                agent_name = node_name

                if hasattr(message, "content") and message.content:
                    content = message.content
                    if hasattr(message, "name") and message.name:
                        agent_name = message.name
                elif isinstance(message, dict) and message.get("content"):
                    content = message["content"]
                    agent_name = message.get("name", node_name)

                if not content or agent_name in ("user", "human"):
                    continue
                # Skip middleware echo nodes that just repeat user input
                if "middleware" in node_name.lower():
                    continue

                agent_name = re.sub(r"[^a-zA-Z0-9_-]", "_", str(agent_name))

                # Deduplicate
                agent_key = f"{agent_name}:{len(agent_responses.get(agent_name, []))}"
                if agent_key in responded_agents:
                    continue
                responded_agents.add(agent_key)

                if agent_name not in agent_responses:
                    agent_responses[agent_name] = []
                agent_responses[agent_name].append(content)

                response_chunk = f"## {agent_name.capitalize()} Response:\n{content}"
                chunk_data = json.dumps({"chunk": response_chunk, "agent": agent_name})
                print(f"Yielding chunk from {agent_name}")
                yield chunk_data

                await asyncio.sleep(0.05)

    if not agent_responses:
        print("No agent responses, yielding default message")
        yield json.dumps({
            "chunk": "I couldn't process your query. Please try again with a different question.",
            "agent": "system",
        })
