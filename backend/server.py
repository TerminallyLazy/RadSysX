#!/usr/bin/env python
"""A FastAPI server exposing the medical research assistant API."""

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from novion import process_query, stream_query  # Import both functions

app = FastAPI(title="Medical Research Assistant API")

# ✅ Enable CORS (Allow frontend to call API)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins (change in production)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Define request model
class QueryRequest(BaseModel):
    query: str

# ✅ Expose the query-processing endpoint
@app.post("/process")
async def process(request: QueryRequest):
    """API endpoint to process user queries and return only human-readable content."""
    try:
        response = process_query(request.query)
        # Ensure response is always returned in a consistent format
        if isinstance(response, list):
            return {"responses": response}
        else:
            return {"responses": [response] if isinstance(response, str) else [str(response)]}
    except Exception as e:
        import traceback
        print(f"Error processing query: {str(e)}")
        print(traceback.format_exc())
        return {"responses": ["Sorry, an error occurred while processing your query. Please try again later."]}

# New streaming endpoint
@app.post("/stream")
@app.get("/stream")  # Add support for GET requests for EventSource
async def stream(request: Request):
    """API endpoint to stream user query responses as they become available."""
    # Handle both GET and POST requests
    if request.method == "GET":
        # Extract query from URL parameters
        query_params = dict(request.query_params)
        user_query = query_params.get("query", "")
    else:
        # For POST requests, extract from JSON body
        try:
            body = await request.json()
            user_query = body.get("query", "")
        except:
            user_query = ""
    
    if not user_query:
        return {"error": "No query provided"}
    
    async def event_generator():
        try:
            # Use a generator function from novion
            async for chunk in stream_query(user_query):
                if chunk:
                    # Format each chunk as a Server-Sent Event
                    yield f"data: {chunk}\n\n"
        except Exception as e:
            import traceback
            print(f"Error in streaming: {str(e)}")
            print(traceback.format_exc())
            yield f"data: Sorry, an error occurred while processing your query. Please try again later.\n\n"
        # Signal end of stream
        yield f"data: [DONE]\n\n"
    
    # Return a streaming response with the SSE media type
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream"
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
