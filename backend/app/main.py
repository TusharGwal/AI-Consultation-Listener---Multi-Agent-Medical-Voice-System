from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.models import APIKey

from app.api.routes.consultation_listener_routes import router as consultation_listener_routes

app = FastAPI(
    title="AI Consultation Listener – Multi-Agent Medical Voice System",
    description="Voice-first, multi-agent medical consultation listener",
    version="1.0.0"
)

# ✅ Enable CORS so frontend (Vercel + local dev) can talk to backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5173",               # local dev server
        "http://localhost:5173"                # alternate local dev URL
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Session-Id", "X-Consultation-Id", "X-Question", "X-Answer"],
)

app.openapi_schema = None

from fastapi.openapi.utils import get_openapi

def custom_openapi():
    if app.openapi_schema:
        return app.openapi_schema
    openapi_schema = get_openapi(
        title=app.title,
        version=app.version,
        description=app.description,
        routes=app.routes,
    )
    openapi_schema["components"]["securitySchemes"] = {
        "BearerAuth": {
            "type": "http",
            "scheme": "bearer",
            "bearerFormat": "JWT"
        }
    }
    for path in openapi_schema["paths"].values():
        for method in path.values():
            method.setdefault("security", []).append({"BearerAuth": []})
    app.openapi_schema = openapi_schema
    return app.openapi_schema

app.openapi = custom_openapi

app.include_router(consultation_listener_routes)

@app.on_event("startup")
def startup_event():
    pass
