import os
from dotenv import load_dotenv
from pydantic_settings import BaseSettings

load_dotenv()


class Settings(BaseSettings):
    """Minimal runtime settings for the consultation listener."""

    # Azure AI Configuration
    AZURE_FOUNDRY_API_KEY: str = os.getenv("AZURE_FOUNDRY_API_KEY", "")
    AZURE_FOUNDRY_ENDPOINT: str = os.getenv("AZURE_FOUNDRY_ENDPOINT", "")
    AZURE_CHAT_DEPLOYMENT: str = os.getenv("AZURE_CHAT_DEPLOYMENT", "gpt-4o")
    AZURE_EMBEDDINGS_DEPLOYMENT: str = os.getenv("AZURE_EMBEDDINGS_DEPLOYMENT", "text-embedding-3-large")
    AZURE_TTS_DEPLOYMENT: str = os.getenv("AZURE_TTS_DEPLOYMENT", "gpt-4o-mini-tts")
    AZURE_TTS_VOICE: str = os.getenv("AZURE_TTS_VOICE", "alloy")

    class Config:
        case_sensitive = True


settings = Settings()