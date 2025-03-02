from typing import Literal, AsyncGenerator
from typing_extensions import TypedDict

from langchain_openai import ChatOpenAI
from langgraph.graph import MessagesState, END
from langgraph.types import Command

from langchain_core.messages import HumanMessage
from langgraph.graph import StateGraph, START, END
from langgraph.prebuilt import create_react_agent

from tools.medications import get_drug_use_cases, search_drugs_for_condition
from tools.medical_info import search_wikem
from tools.researcher import search_pubmed, fetch_pubmed_details, get_pubmed_identifiers, get_pmc_link, retrieve_article_text

from IPython.display import display, Image

from dotenv import load_dotenv
import json
import asyncio

import re

load_dotenv(dotenv_path="../.env.local")

members = ["pharmacist", "researcher", "medical_analyst"]
# Our team supervisor is an LLM node. It just picks the next agent to process
# and decides when the work is completed
options = members + ["FINISH"]

system_prompt = (
    "You are a supervisor tasked with managing a conversation between the"
    f" following workers: {members}. Given the following user request,"
    " respond with the worker to act next. Each worker will perform a"
    " task and respond with their results and status. When finished,"
    " respond with FINISH."
)


class Router(TypedDict):
    """Worker to route to next. If no workers needed, route to FINISH."""

    next: Literal["pharmacist", "researcher", "medical_analyst", "FINISH"]


llm = ChatOpenAI(model="gpt-4o-mini")


class State(MessagesState):
    next: str


def supervisor_node(state: State) -> Command[Literal["pharmacist", "researcher", "medical_analyst", "__end__"]]:
    messages = [
        {"role": "system", "content": system_prompt},
    ] + state["messages"]

    # Ensure all names in messages conform to the pattern
    for message in messages:
        if 'name' in message:
            message['name'] = re.sub(r'[^a-zA-Z0-9_-]', '_', message['name'])

    response = llm.with_structured_output(Router).invoke(messages)
    goto = response["next"]
    if goto == "FINISH":
        goto = END

    return Command(goto=goto, update={"next": goto})


pharamcist_agent = create_react_agent(
    llm, tools=[get_drug_use_cases, search_drugs_for_condition]
)


def pharmacist_node(state: State) -> Command[Literal["supervisor"]]:
    result = pharamcist_agent.invoke(state)
    return Command(
        update={
            "messages": [
                HumanMessage(content=result["messages"]
                             [-1].content, name="pharmacist")
            ]
        },
        goto="supervisor",
    )

researcher_agent = create_react_agent(
    llm, tools=[search_pubmed, fetch_pubmed_details, get_pubmed_identifiers, get_pmc_link, retrieve_article_text]
)

medical_analyst_agent = create_react_agent(llm, tools=[search_wikem])


def medical_analyst_node(state: State) -> Command[Literal["supervisor"]]:
    result = medical_analyst_agent.invoke(state)
    return Command(
        update={
            "messages": [
                HumanMessage(content=result["messages"]
                             [-1].content, name="medical_analyst")
                ]
            },
            goto="supervisor",
    )

def researcher_node(state: State) -> Command[Literal["supervisor"]]:
    try:
        result = researcher_agent.invoke(state)
        
        # Get the content from the result
        content = result["messages"][-1].content
        
        # Improve URL formatting for PubMed links - simplified to avoid nested links
        if "http" in content or "www." in content or "PMID" in content:
            # First, handle PubMed-specific references with cleaner formatting
            content = re.sub(r'PMID:?\s*(\d+)', r'PMID: \1 (https://pubmed.ncbi.nlm.nih.gov/\1/)', content)
            
            # Clean up any malformed double URL patterns that might exist
            content = re.sub(r'\[https?://[^\]]+\]\(https?://[^)]+\)', lambda m: m.group(0).split('](')[1][:-1], content)
            
            # Format any remaining raw URLs without creating nested structures
            content = re.sub(r'(?<!\()(https?://[^\s\)<>]+)(?!\))', r'\1', content)
            
            # Remove any "Read more here" text that might be causing confusion
            content = content.replace("Read more here", "")
            
            # Add a note about clickable links
            content += "\n\n*Note: All URLs in this response are directly clickable.*"
        
        return Command(
            update={
                "messages": [
                    HumanMessage(content=content, name="researcher")
                ]
            },
            goto="supervisor",
        )
    except Exception as e:
        error_message = f"I encountered a technical issue while searching medical research databases: {str(e)}. Let me provide general information instead."
        return Command(
            update={
                "messages": [
                    HumanMessage(content=error_message, name="researcher")
                ]
            },
            goto="supervisor",
        )

builder = StateGraph(State)
builder.add_edge(START, "supervisor")
builder.add_node("supervisor", supervisor_node)
builder.add_node("pharmacist", pharmacist_node)
builder.add_node("medical_analyst", medical_analyst_node)
builder.add_node("researcher", researcher_node)
graph = builder.compile()

def process_query(query: str):
    """Process user query using the compiled graph and extract HumanMessage content."""
    results = []
    responses = []
    agent_responses = {}  # Store responses by agent
    
    # Ensure proper message format for the LangChain graph
    # Using HumanMessage object instead of a tuple
    input_message = HumanMessage(content=query)
    
    # Stream through the LangChain response
    for s in graph.stream({"messages": [input_message]}, subgraphs=True):
        # Extract only HumanMessage contents
        for key, value in s[1].items():
            if "messages" in value:
                for message in value["messages"]:
                    if isinstance(message, HumanMessage):
                        agent_name = message.name if hasattr(message, 'name') else "agent"
                        content = message.content
                        
                        # Store by agent for debugging
                        if agent_name not in agent_responses:
                            agent_responses[agent_name] = []
                        agent_responses[agent_name].append(content)
                        
                        # Add agent name as a prefix if it exists
                        if agent_name and agent_name not in ["user", "human"]:
                            content = f"## {agent_name.capitalize()} Response:\n{content}"
                        results.append(content)  # Collect HumanMessage content with agent name
                        print(f"Added message from {agent_name}: {content[:100]}...")  # Debug content being added
            if "responses" in value:
                responses.extend(value["responses"])  # Collect responses
                
        # Print some debug info to help troubleshoot
        print(f"Stream result: {s}")

    # Print agent summary
    print("\n----- AGENT RESPONSE SUMMARY -----")
    for agent, msgs in agent_responses.items():
        print(f"Agent: {agent} - {len(msgs)} messages")
        for i, msg in enumerate(msgs):
            print(f"  Message {i+1}: {len(msg)} chars")
    print("----- END SUMMARY -----\n")
    
    # Check if we have any results, return a default message if not
    if not results:
        # Check if there are responses as a fallback
        if responses:
            return responses
        return ["I couldn't process your query. Please try again with a different question."]
    
    # Print final results for debugging
    print(f"Final results count: {len(results)}")
    for i, result in enumerate(results):
        print(f"Result {i+1} length: {len(result)} chars")
        print(f"Result {i+1} preview: {result[:100]}...")
    
    return results   # Return all collected results instead of just the first one

# New streaming function
async def stream_query(query: str) -> AsyncGenerator[str, None]:
    """
    Stream user query responses as they become available.
    
    This is a generator function that yields chunks of the response
    as they become available from different agents.
    """
    print(f"Starting stream_query with query: {query}")
    
    results = []
    agent_responses = {}  # Store responses by agent
    
    # Ensure proper message format for the LangChain graph
    input_message = HumanMessage(content=query)
    
    # Keep track of agents that have already responded
    responded_agents = set()
    
    # Stream through the LangChain response
    for s in graph.stream({"messages": [input_message]}, subgraphs=True):
        # Extract only HumanMessage contents
        for key, value in s[1].items():
            if "messages" in value:
                for message in value["messages"]:
                    if isinstance(message, HumanMessage):
                        agent_name = message.name if hasattr(message, 'name') else "agent"
                        content = message.content
                        
                        # Only yield new agent responses to avoid duplicates
                        agent_key = f"{agent_name}:{len(agent_responses.get(agent_name, []))}"
                        if agent_key not in responded_agents:
                            responded_agents.add(agent_key)
                            
                            # Store by agent for debugging
                            if agent_name not in agent_responses:
                                agent_responses[agent_name] = []
                            agent_responses[agent_name].append(content)
                            
                            # Add agent name as a prefix if it exists
                            if agent_name and agent_name not in ["user", "human"]:
                                response_chunk = f"## {agent_name.capitalize()} Response:\n{content}"
                                chunk_data = json.dumps({"chunk": response_chunk, "agent": agent_name})
                                print(f"Yielding chunk from {agent_name}")
                                yield chunk_data
                                
                                # Small delay to allow frontend to process
                                await asyncio.sleep(0.05)
        
    # If no results, return a default message
    if not agent_responses:
        print("No agent responses, yielding default message")
        yield json.dumps({"chunk": "I couldn't process your query. Please try again with a different question.", "agent": "system"})