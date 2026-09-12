FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    RECEPTIONIST_AUDIO_DIR=/var/lib/vocivo-receptionist \
    HF_HOME=/var/lib/vocivo-receptionist/models

# ffmpeg is what faster-whisper uses to read the narrowband WAV files
# FreeSWITCH records.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# The Live adapter is installed independently; choosing it remains an explicit runtime setting.
COPY requirements-live.txt .
RUN pip install --no-cache-dir -r requirements-live.txt
COPY app ./app
RUN mkdir -p /var/lib/vocivo-receptionist
EXPOSE 8084
CMD ["python", "-m", "app.main"]
