import os
import json
import asyncio
import hashlib
from io import BytesIO
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pypdf import PdfReader
from openai import AsyncOpenAI
from pydantic import BaseModel, Field


# ============================================================
# LOAD .ENV FILE
# ============================================================

BASE_DIR = Path(__file__).resolve().parent
ENV_FILE = BASE_DIR / ".env"

load_dotenv(dotenv_path=ENV_FILE)


# ============================================================
# CONFIG (env-driven, with sane defaults)
# ============================================================

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")

if not OPENROUTER_API_KEY:
    raise RuntimeError(
        f"OPENROUTER_API_KEY was not found.\n"
        f"Make sure your .env file exists here:\n"
        f"{ENV_FILE}"
    )

MODEL = os.getenv("OPENROUTER_MODEL", "google/gemini-2.5-flash-lite")
TEMPERATURE = float(os.getenv("OPENROUTER_TEMPERATURE", "0.3"))
REQUEST_TIMEOUT_SECONDS = float(os.getenv("OPENROUTER_TIMEOUT", "60"))

# Guardrails against oversized / abusive input
MAX_PDF_BYTES = int(os.getenv("MAX_PDF_BYTES", str(8 * 1024 * 1024)))       # 8 MB
MAX_RESUME_CHARS = int(os.getenv("MAX_RESUME_CHARS", "20000"))              # ~5-6k tokens
MAX_ANSWER_CHARS = int(os.getenv("MAX_ANSWER_CHARS", "6000"))
MARKS_PER_QUESTION = int(os.getenv("MARKS_PER_QUESTION", "10"))

CORS_ORIGINS = os.getenv("CORS_ORIGINS", "*")
_origins = ["*"] if CORS_ORIGINS.strip() == "*" else [
    o.strip() for o in CORS_ORIGINS.split(",") if o.strip()
]


# ============================================================
# FASTAPI APP
# ============================================================

app = FastAPI(
    title="Resume Interview Question Generator",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"]
)


# ============================================================
# ASYNC OPENROUTER CLIENT
# Using AsyncOpenAI so calls don't block the event loop.
# ============================================================

client = AsyncOpenAI(
    api_key=OPENROUTER_API_KEY,
    base_url="https://openrouter.ai/api/v1",
    timeout=REQUEST_TIMEOUT_SECONDS,
)


# ============================================================
# SIMPLE IN-MEMORY CACHE
# Avoids re-paying for AI calls on a repeat upload of the
# same resume text. Not persistent, not multi-process safe —
# fine for a single-instance demo/dev deployment.
# ============================================================

_analysis_cache: dict[str, dict] = {}


def _hash_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ============================================================
# PDF TEXT EXTRACTION
# ============================================================

def extract_text_from_pdf(pdf_bytes: bytes) -> str:
    """
    Extract text from an uploaded PDF.
    """
    try:
        reader = PdfReader(BytesIO(pdf_bytes))

        text = []
        for page in reader.pages:
            page_text = page.extract_text()
            if page_text:
                text.append(page_text)

        return "\n".join(text).strip()

    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail=f"Could not read PDF: {str(e)}"
        )


# ============================================================
# CLEAN AI JSON RESPONSE
# Strips ``` / ```json fences the model sometimes adds even
# when told not to.
# ============================================================

def clean_json_response(result: str) -> str:
    result = result.strip()

    if result.startswith("```json"):
        result = result[7:]
    elif result.startswith("```"):
        result = result[3:]

    if result.endswith("```"):
        result = result[:-3]

    return result.strip()


def _safe_json_loads(raw: str) -> Optional[dict]:
    """
    Try to parse AI JSON output. Returns None on failure instead
    of raising, so callers can apply a consistent fallback shape.
    """
    try:
        return json.loads(clean_json_response(raw))
    except json.JSONDecodeError:
        return None


# ============================================================
# AI REQUEST (async)
# ============================================================

async def ask_ai(prompt: str) -> str:
    try:
        response = await client.chat.completions.create(
            model=MODEL,
            messages=[{"role": "user", "content": prompt}],
            temperature=TEMPERATURE,
        )

        if not response.choices:
            raise Exception("AI returned no response.")

        content = response.choices[0].message.content

        if not content:
            raise Exception("AI returned an empty response.")

        return content

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"OpenRouter request failed: {str(e)}"
        )


# ============================================================
# COMBINED ANALYSIS: role + interview questions in ONE call
#
# Merging these (previously two separate round-trips) cuts
# latency and token cost roughly in half per resume, and lets
# the model use its own detected experience_level to calibrate
# question difficulty in the same pass (it no longer gets lost
# between two disconnected calls).
# ============================================================

async def analyze_resume_with_ai(resume_text: str) -> dict:
    prompt = f"""
You are an expert career analyst, recruiter, and professional interviewer.

The candidate can belong to ANY profession or industry. Do not assume
engineering, IT, software, finance, healthcare, education, marketing,
design, or any predefined field. Base everything only on evidence in
the resume. Do not invent skills, experience, qualifications, or
projects.

STEP 1 — Identify the candidate's most likely professional role, field,
specialization, and experience level, using only resume evidence.

STEP 2 — Using that identified role AND experience level, create exactly
10 personalized interview questions. Choose question categories
dynamically according to the candidate's actual role and background.
Do not generate technical questions unless technical knowledge is
relevant to the candidate's role. Personalize questions using actual
skills, projects, experience, responsibilities, tools, achievements,
education, or certifications found in the resume. Match each
question's difficulty to the candidate's apparent experience level.

For every question provide: category, question, difficulty, and
ideal_answer (a concise reference explanation usable to check the
meaning and factual correctness of a candidate's spoken answer).

Return ONLY valid JSON, no markdown, no text outside the JSON, using
exactly this structure:

{{
    "role": "Detected professional role",
    "field": "Detected professional field",
    "specialization": "Detected specialization or a short explicit note that none is evident",
    "experience_level": "Detected experience level (e.g. Entry-level, Mid-level, Senior) or a short explicit note that it is unclear",
    "confidence": 0.0,
    "reason": "Short evidence-based explanation",
    "questions": [
        {{
            "category": "Role-Specific",
            "question": "Interview question",
            "difficulty": "Medium",
            "ideal_answer": "Concise reference answer"
        }}
    ]
}}

Rules:
1. Do not use markdown.
2. Do not add text outside the JSON object.
3. confidence must be a number between 0 and 1.
4. specialization and experience_level must never be null — use a
   short descriptive string even when evidence is limited.
5. Generate exactly 10 questions, no duplicates.
6. Keep questions practical, interview-ready, and keep ideal_answer
   concise to reduce output size.
7. For behavioral questions, ideal_answer should describe what a
   strong response should contain rather than a single fixed answer.

Resume:
-------------------------
{resume_text}
-------------------------
"""

    raw = await ask_ai(prompt)
    parsed = _safe_json_loads(raw)

    if parsed is not None:
        return parsed

    # Consistent fallback shape so callers/frontends never have to
    # special-case a parse failure differently from a normal result.
    return {
        "role": "Unknown",
        "field": "Unknown",
        "specialization": "Unknown",
        "experience_level": "Unknown",
        "confidence": None,
        "reason": "AI returned an invalid JSON response.",
        "questions": [],
        "raw_ai_response": raw,
    }


# ============================================================
# ANSWER EVALUATION DATA MODEL
# ============================================================

class AnswerEvaluationRequest(BaseModel):
    question: str = Field(..., min_length=1)
    ideal_answer: str = Field(..., min_length=1)
    candidate_answer: str = Field(..., min_length=1)


# ------------------------------------------------------------
# Bulk / session evaluation (all interview questions at once)
# ------------------------------------------------------------

class SessionAnswerItem(BaseModel):
    question: str = Field(..., min_length=1)
    ideal_answer: str = Field(..., min_length=1)
    candidate_answer: str = Field(default="")  # allow blank = skipped question


class SessionEvaluationRequest(BaseModel):
    answers: list[SessionAnswerItem] = Field(..., min_length=1)


# ============================================================
# EVALUATE CANDIDATE ANSWER (async)
# ============================================================

async def evaluate_candidate_answer(
    question: str,
    ideal_answer: str,
    candidate_answer: str
) -> dict:

    prompt = f"""
You are an interview answer correction engine.

Analyze the candidate's answer to the question.

Your job is NOT to review, rank, or criticize the candidate as a
person. Your job is to check the CONTENT of the explanation and
point out factual or conceptual errors.

Evaluate meaning, not exact wording.

Rules:
- Understand what the candidate is trying to explain.
- Accept different wording when the underlying concept is correct.
- Ignore filler words such as "yeah", "umm", "uh", "like", and
  repeated words.
- Ignore minor grammar problems, accent, vocabulary, and speech
  transcription noise.
- Do not treat a transcription mistake as a knowledge mistake when
  the intended meaning is clear.
- Check factual correctness, relevance, reasoning, and completeness.
- Do not require the candidate to use the same wording as the ideal
  answer.
- Do not invent mistakes.
- If the explanation is correct, clearly say there is no error.
- If partially correct, identify the specific incorrect or missing
  concept.
- Focus on the explanation, not the candidate.
- Do not use personal judgments such as "weak candidate" or "poor
  knowledge".
- Keep the correction concise and useful.
- voice_feedback must be natural and short enough to read aloud.

Return ONLY valid JSON:

{{
    "score": 0,
    "max_score": 10,
    "correctness": "Correct",
    "what_was_correct": "Brief statement about the correct idea.",
    "error": null,
    "correction": null,
    "voice_feedback": "Short spoken feedback."
}}

Scoring:
9-10 = Correct and complete
7-8 = Mostly correct with minor missing detail
5-6 = Partially correct with an important gap or error
3-4 = Mostly incorrect
0-2 = Incorrect or unrelated

Question:
{question}

Ideal Answer:
{ideal_answer}

Candidate Transcript:
{candidate_answer}
"""

    raw = await ask_ai(prompt)
    parsed = _safe_json_loads(raw)

    if parsed is not None:
        return parsed

    return {
        "score": 0,
        "max_score": 10,
        "correctness": "Unable to evaluate",
        "what_was_correct": "",
        "error": "AI returned an invalid JSON response.",
        "correction": None,
        "voice_feedback": "Sorry, I couldn't evaluate that answer. Please try again.",
        "raw_ai_response": raw,
    }


# ============================================================
# HEALTH CHECK
# ============================================================

@app.get("/")
def home():
    return {
        "status": "success",
        "message": "Resume Interview Backend is running"
    }


# ============================================================
# RESUME ANALYSIS ENDPOINT
# ============================================================

@app.post("/analyze-resume")
async def analyze_resume(file: UploadFile = File(...)):

    # --------------------------------------------------------
    # CHECK FILE TYPE (header + magic-byte sanity check)
    # --------------------------------------------------------
    if file.content_type not in ("application/pdf", "application/octet-stream"):
        raise HTTPException(
            status_code=400,
            detail="Please upload a PDF resume."
        )

    # --------------------------------------------------------
    # READ PDF (size-limited to avoid huge uploads / cost blowup)
    # --------------------------------------------------------
    pdf_bytes = await file.read()

    if not pdf_bytes:
        raise HTTPException(
            status_code=400,
            detail="Uploaded PDF is empty."
        )

    if len(pdf_bytes) > MAX_PDF_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"PDF exceeds the {MAX_PDF_BYTES // (1024 * 1024)}MB limit."
        )

    if pdf_bytes[:4] != b"%PDF":
        raise HTTPException(
            status_code=400,
            detail="File does not appear to be a valid PDF."
        )

    # --------------------------------------------------------
    # EXTRACT TEXT
    # --------------------------------------------------------
    resume_text = extract_text_from_pdf(pdf_bytes)

    if not resume_text:
        raise HTTPException(
            status_code=400,
            detail=(
                "Could not extract text from this PDF. "
                "The PDF may be scanned/image-based."
            )
        )

    truncated = len(resume_text) > MAX_RESUME_CHARS
    if truncated:
        resume_text = resume_text[:MAX_RESUME_CHARS]

    # --------------------------------------------------------
    # ANALYZE (role + questions in a single AI call, cached by
    # content hash so repeat uploads of the same resume are free)
    # --------------------------------------------------------
    cache_key = _hash_text(resume_text)

    if cache_key in _analysis_cache:
        analysis = _analysis_cache[cache_key]
    else:
        analysis = await analyze_resume_with_ai(resume_text)
        _analysis_cache[cache_key] = analysis

    role_data = {
        k: v for k, v in analysis.items() if k != "questions"
    }
    interview_data = {
        "role": analysis.get("role", "Unknown"),
        "questions": analysis.get("questions", []),
    }
    if "raw_ai_response" in analysis:
        interview_data["raw_ai_response"] = analysis["raw_ai_response"]

    # --------------------------------------------------------
    # RETURN RESPONSE
    # --------------------------------------------------------
    return {
        "success": True,
        "filename": file.filename,
        "identified_role": role_data,
        "interview_questions": interview_data,
        "resume_text_truncated": truncated,
        "resume_text": resume_text,
    }


# ============================================================
# ANSWER EVALUATION ENDPOINT
# ============================================================

@app.post("/evaluate-answer")
async def evaluate_answer(data: AnswerEvaluationRequest):

    if not data.candidate_answer.strip():
        raise HTTPException(
            status_code=400,
            detail="Candidate answer cannot be empty."
        )

    candidate_answer = data.candidate_answer[:MAX_ANSWER_CHARS]

    evaluation = await evaluate_candidate_answer(
        question=data.question,
        ideal_answer=data.ideal_answer,
        candidate_answer=candidate_answer,
    )

    return {
        "success": True,
        "evaluation": evaluation
    }


# ============================================================
# SESSION EVALUATION ENDPOINT
# Scores every question of an interview at once, each worth
# MARKS_PER_QUESTION (default 10), and returns the total.
#
# All answers are evaluated concurrently (asyncio.gather) rather
# than one HTTP round-trip per question from the frontend, which
# is both faster and avoids 10 separate client-side requests.
# A blank candidate_answer is scored as 0 without calling the AI,
# since there's nothing to evaluate.
# ============================================================

@app.post("/evaluate-session")
async def evaluate_session(data: SessionEvaluationRequest):

    async def score_one(item: SessionAnswerItem) -> dict:
        answer = item.candidate_answer.strip()

        if not answer:
            return {
                "question": item.question,
                "score": 0,
                "max_score": MARKS_PER_QUESTION,
                "correctness": "Not answered",
                "what_was_correct": "",
                "error": "No answer was provided.",
                "correction": None,
                "voice_feedback": "No answer was recorded for this question.",
            }

        result = await evaluate_candidate_answer(
            question=item.question,
            ideal_answer=item.ideal_answer,
            candidate_answer=answer[:MAX_ANSWER_CHARS],
        )

        # Model scores 0-10 internally; rescale to MARKS_PER_QUESTION
        # in case that config value is ever changed from the default.
        raw_score = result.get("score", 0) or 0
        raw_max = result.get("max_score", 10) or 10

        try:
            scaled_score = round((raw_score / raw_max) * MARKS_PER_QUESTION, 2)
        except ZeroDivisionError:
            scaled_score = 0

        return {
            "question": item.question,
            **result,
            "score": scaled_score,
            "max_score": MARKS_PER_QUESTION,
        }

    results = await asyncio.gather(*(score_one(item) for item in data.answers))

    total_score = round(sum(r["score"] for r in results), 2)
    max_total = len(results) * MARKS_PER_QUESTION
    percentage = round((total_score / max_total) * 100, 2) if max_total else 0

    return {
        "success": True,
        "question_count": len(results),
        "marks_per_question": MARKS_PER_QUESTION,
        "results": results,
        "total_score": total_score,
        "max_total": max_total,
        "percentage": percentage,
    }