const CONFIGURED_API_BASE = String(window.RESUMESYNC_API_BASE || "").trim().replace(/\/+$/, "");
const IS_LOCAL_HOST = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const API_BASE = CONFIGURED_API_BASE || (IS_LOCAL_HOST ? "http://127.0.0.1:8000" : "");

let questions = [];
let currentQuestionIndex = 0;
let interviewResults = [];
let analysisData = null;
let recognition = null;
let isListening = false;


// ============================================================
// DOM HELPER
// ============================================================

const $ = (id) => document.getElementById(id);


// ============================================================
// SCREEN ELEMENTS
// ============================================================

const uploadScreen = $("uploadScreen");
const interviewScreen = $("interviewScreen");
const resultScreen = $("resultScreen");

const resumeInput = $("resumeInput");
const dropZone = $("dropZone");
const selectedFile = $("selectedFile");
const analyzeBtn = $("analyzeBtn");
const uploadError = $("uploadError");

const loaderOverlay = $("loaderOverlay");
const loaderTitle = $("loaderTitle");
const loaderText = $("loaderText");


// ============================================================
// SHOW SCREEN
// ============================================================

function showScreen(screen) {

    [uploadScreen, interviewScreen, resultScreen].forEach(
        (item) => {
            item.classList.remove("active");
        }
    );

    screen.classList.add("active");
}


// ============================================================
// LOADER
// ============================================================

function setLoading(show, title = "", text = "") {

    loaderOverlay.classList.toggle(
        "hidden",
        !show
    );

    if (show) {

        loaderTitle.textContent = title;
        loaderText.textContent = text;

    }
}


// ============================================================
// FILE UPLOAD
// ============================================================

resumeInput.addEventListener(
    "change",
    () => {

        const file = resumeInput.files[0];

        if (!file) {

            selectedFile.textContent =
                "No file selected";

            analyzeBtn.disabled = true;

            return;
        }


        if (
            file.type !== "application/pdf" &&
            !file.name.toLowerCase().endsWith(".pdf")
        ) {

            selectedFile.textContent =
                "Please select a PDF";

            analyzeBtn.disabled = true;

            return;
        }


        selectedFile.textContent =
            file.name;

        analyzeBtn.disabled = false;

        uploadError.classList.add(
            "hidden"
        );
    }
);


// ============================================================
// DRAG AND DROP
// ============================================================

["dragenter", "dragover"].forEach(
    (eventName) => {

        dropZone.addEventListener(
            eventName,
            (event) => {

                event.preventDefault();

                dropZone.classList.add(
                    "dragging"
                );
            }
        );
    }
);


["dragleave", "drop"].forEach(
    (eventName) => {

        dropZone.addEventListener(
            eventName,
            (event) => {

                event.preventDefault();

                dropZone.classList.remove(
                    "dragging"
                );
            }
        );
    }
);


dropZone.addEventListener(
    "drop",
    (event) => {

        const file =
            event.dataTransfer.files[0];

        if (!file) {
            return;
        }


        if (
            file.type !== "application/pdf" &&
            !file.name.toLowerCase().endsWith(".pdf")
        ) {

            selectedFile.textContent =
                "Please drop a PDF";

            analyzeBtn.disabled = true;

            return;
        }


        resumeInput.files =
            event.dataTransfer.files;

        selectedFile.textContent =
            file.name;

        analyzeBtn.disabled = false;
    }
);


// ============================================================
// ANALYZE RESUME
// ============================================================

analyzeBtn.addEventListener(
    "click",
    analyzeResume
);


async function analyzeResume() {

    const file =
        resumeInput.files[0];

    if (!file) {
        return;
    }


    const formData =
        new FormData();

    formData.append(
        "file",
        file
    );


    setLoading(
        true,
        "Analyzing resume...",
        "Identifying the professional role and preparing personalized interview questions."
    );


    try {

        if (!API_BASE) {
            throw new Error("The backend URL is not configured. Set window.RESUMESYNC_API_BASE in frontend/config.js to your deployed FastAPI URL.");
        }

        const response =
            await fetch(
                `${API_BASE}/analyze-resume`,
                {
                    method: "POST",
                    body: formData
                }
            );


        const data =
            await response.json();


        if (!response.ok) {

            throw new Error(
                data.detail ||
                "Resume analysis failed."
            );
        }


        analysisData = data;


        questions =
            data.interview_questions?.questions || [];


        if (!questions.length) {

            throw new Error(
                "The AI did not return any interview questions."
            );
        }


        setupCandidateProfile(
            data
        );


        currentQuestionIndex = 0;

        interviewResults = [];


        showScreen(
            interviewScreen
        );


        displayQuestion();


    } catch (error) {

        uploadError.textContent =
            error.message;

        uploadError.classList.remove(
            "hidden"
        );


    } finally {

        setLoading(false);

    }
}


// ============================================================
// SETUP CANDIDATE PROFILE
// ============================================================

function setupCandidateProfile(data) {

    const profile =
        data.identified_role || {};


    const role =
        profile.role ||
        "Professional";


    const field =
        profile.field ||
        "Professional Field";


    $("roleTitle").textContent =
        role;


    $("fieldTitle").textContent =
        field;


    $("specialization").textContent =
        profile.specialization ||
        "—";


    $("experienceLevel").textContent =
        profile.experience_level ||
        "—";


    $("confidence").textContent =
        typeof profile.confidence === "number"
            ? `${Math.round(profile.confidence * 100)}%`
            : "—";


    $("roleReason").textContent =
        profile.reason ||
        "—";


    const initials = role
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map(
            (word) => word[0]
        )
        .join("")
        .toUpperCase();


    $("profileAvatar").textContent =
        initials || "AI";
}


// ============================================================
// DISPLAY QUESTION
// ============================================================

function displayQuestion() {

    if (!questions.length) {
        return;
    }


    const question =
        questions[currentQuestionIndex];


    $("questionNumber").textContent =
        `Question ${currentQuestionIndex + 1} of ${questions.length}`;


    $("progressFill").style.width =
        `${((currentQuestionIndex + 1) / questions.length) * 100}%`;


    $("questionCategory").textContent =
        question.category ||
        "Interview";


    $("questionDifficulty").textContent =
        question.difficulty ||
        "Medium";


    $("questionText").textContent =
        question.question ||
        "";


    $("answerText").value = "";


    $("listeningState").textContent =
        "Ready";


    $("listeningState").classList.remove(
        "listening"
    );


    $("evaluationCard").classList.add(
        "hidden"
    );


    $("startMicBtn").disabled =
        !recognition;


    $("stopMicBtn").disabled =
        true;


    $("submitAnswerBtn").disabled =
        false;


    $("speakLabel").textContent =
        "Read Question Aloud";


    // Automatically speak the question
    setTimeout(
        () => {

            speakText(
                question.question
            );

        },
        350
    );
}


// ============================================================
// TEXT TO SPEECH
// ============================================================

function speakText(text) {

    if (!("speechSynthesis" in window)) {

        return;
    }


    window.speechSynthesis.cancel();


    const utterance =
        new SpeechSynthesisUtterance(
            text
        );


    utterance.lang =
        "en-US";


    utterance.rate =
        0.88;


    utterance.pitch =
        1;


    window.speechSynthesis.speak(
        utterance
    );
}


// ============================================================
// READ QUESTION BUTTON
// ============================================================

$("speakBtn").addEventListener(
    "click",
    () => {

        const question =
            questions[currentQuestionIndex];


        if (!question) {
            return;
        }


        speakText(
            question.question
        );


        $("speakLabel").textContent =
            "Playing Question...";


        setTimeout(
            () => {

                $("speakLabel").textContent =
                    "Read Question Aloud";

            },
            2200
        );
    }
);


// ============================================================
// SPEECH RECOGNITION
// ============================================================

function setupSpeechRecognition() {

    const SpeechRecognition =
        window.SpeechRecognition ||
        window.webkitSpeechRecognition;


    if (!SpeechRecognition) {

        $("speechSupport").textContent =
            "Speech recognition is not supported in this browser. You can type the answer instead.";


        $("startMicBtn").disabled =
            true;


        return;
    }


    recognition =
        new SpeechRecognition();


    recognition.continuous =
        true;


    recognition.interimResults =
        true;


    recognition.lang =
        "en-US";


    // --------------------------------------------------------
    // START
    // --------------------------------------------------------

    recognition.onstart =
        () => {

            isListening = true;


            $("listeningState").textContent =
                "Listening...";


            $("listeningState").classList.add(
                "listening"
            );


            $("startMicBtn").disabled =
                true;


            $("stopMicBtn").disabled =
                false;
        };


    // --------------------------------------------------------
    // RESULT
    // --------------------------------------------------------

    recognition.onresult =
        (event) => {

            let transcript = "";


            for (
                let i = 0;
                i < event.results.length;
                i++
            ) {

                transcript +=
                    event.results[i][0]
                        .transcript +
                    " ";
            }


            $("answerText").value =
                transcript.trim();
        };


    // --------------------------------------------------------
    // ERROR
    // --------------------------------------------------------

    recognition.onerror =
        (event) => {

            console.error(
                "Speech recognition error:",
                event.error
            );


            $("listeningState").textContent =
                `Voice error: ${event.error}`;


            $("listeningState").classList.remove(
                "listening"
            );


            isListening =
                false;


            $("startMicBtn").disabled =
                false;


            $("stopMicBtn").disabled =
                true;
        };


    // --------------------------------------------------------
    // END
    // --------------------------------------------------------

    recognition.onend =
        () => {

            isListening =
                false;


            $("listeningState").textContent =
                "Ready";


            $("listeningState").classList.remove(
                "listening"
            );


            $("startMicBtn").disabled =
                false;


            $("stopMicBtn").disabled =
                true;
        };
}


// ============================================================
// START MICROPHONE
// ============================================================

$("startMicBtn").addEventListener(
    "click",
    () => {

        if (!recognition) {
            return;
        }


        $("answerText").value =
            "";


        try {

            recognition.start();

        } catch (error) {

            console.log(
                "Recognition already running."
            );
        }
    }
);


// ============================================================
// STOP MICROPHONE
// ============================================================

$("stopMicBtn").addEventListener(
    "click",
    () => {

        stopRecognition();

    }
);


function stopRecognition() {

    if (
        recognition &&
        isListening
    ) {

        recognition.stop();

    }
}


// ============================================================
// SUBMIT ANSWER
// ============================================================

$("submitAnswerBtn").addEventListener(
    "click",
    submitAnswer
);


async function submitAnswer() {

    if (isListening) {

        stopRecognition();

    }


    const question =
        questions[currentQuestionIndex];


    const candidateAnswer =
        $("answerText")
            .value
            .trim();


    if (!candidateAnswer) {

        alert(
            "Please provide an answer first."
        );

        return;
    }


    $("submitAnswerBtn").disabled =
        true;


    setLoading(
        true,
        "Checking your explanation...",
        "The AI is identifying what you explained correctly and any factual or conceptual errors."
    );


    try {

        if (!API_BASE) {
            throw new Error("The backend URL is not configured. Set window.RESUMESYNC_API_BASE in frontend/config.js to your deployed FastAPI URL.");
        }

        const response =
            await fetch(
                `${API_BASE}/evaluate-answer`,
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body: JSON.stringify({

                        question:
                            question.question,

                        ideal_answer:
                            question.ideal_answer,

                        candidate_answer:
                            candidateAnswer
                    })
                }
            );


        const data =
            await response.json();


        if (!response.ok) {

            throw new Error(
                data.detail ||
                "Answer evaluation failed."
            );
        }


        const evaluation =
            data.evaluation ||
            data;


        interviewResults[
            currentQuestionIndex
        ] = {

            question:
                question.question,

            score:
                Number(
                    evaluation.score || 0
                ),

            max_score:
                Number(
                    evaluation.max_score || 10
                ),

            correctness:
                evaluation.correctness ||
                "Evaluated",

            what_was_correct:
                evaluation.what_was_correct ||
                "",

            error:
                evaluation.error ||
                null,

            correction:
                evaluation.correction ||
                null,

            voice_feedback:
                evaluation.voice_feedback ||
                ""
        };


        displayEvaluation(
            evaluation
        );


    } catch (error) {

        $("submitAnswerBtn").disabled =
            false;


        alert(
            error.message
        );


    } finally {

        setLoading(false);

    }
}


// ============================================================
// DISPLAY EVALUATION
// ============================================================

function displayEvaluation(
    evaluation
) {

    $("evaluationCard").classList.remove(
        "hidden"
    );


    $("scoreValue").textContent =
        evaluation.score ?? 0;


    $("correctnessLabel").textContent =
        evaluation.correctness ||
        "Evaluated";


    $("correctPart").textContent =
        evaluation.what_was_correct ||
        "No specific correct point was returned.";


    $("errorPart").textContent =
        evaluation.error ||
        "No factual or conceptual error detected.";


    $("correctionPart").textContent =
        evaluation.correction ||
        "No correction needed.";


    $("voiceFeedback").textContent =
        evaluation.voice_feedback ||
        "No additional feedback.";


    $("nextBtn").textContent =
        currentQuestionIndex ===
        questions.length - 1
            ? "Finish Interview →"
            : "Next Question →";


    // Speak the correction
    if (
        evaluation.voice_feedback
    ) {

        setTimeout(
            () => {

                speakText(
                    evaluation.voice_feedback
                );

            },
            400
        );
    }
}


// ============================================================
// SPEAK AI FEEDBACK
// ============================================================

$("speakFeedbackBtn").addEventListener(
    "click",
    () => {

        speakText(
            $("voiceFeedback").textContent
        );

    }
);


// ============================================================
// NEXT QUESTION
// ============================================================

$("nextBtn").addEventListener(
    "click",
    handleNextQuestion
);


async function handleNextQuestion() {

    if (
        currentQuestionIndex <
        questions.length - 1
    ) {

        currentQuestionIndex++;

        displayQuestion();

        return;
    }


    await finishInterview();
}


// ============================================================
// FINISH INTERVIEW
// ============================================================

async function finishInterview() {

    setLoading(
        true,
        "Finishing interview...",
        "Preparing your final interview score."
    );


    try {

        const totalScore =
            interviewResults.reduce(
                (sum, item) =>
                    sum +
                    Number(
                        item.score || 0
                    ),
                0
            );


        const maxTotal =
            interviewResults.reduce(
                (sum, item) =>
                    sum +
                    Number(
                        item.max_score || 10
                    ),
                0
            );


        const percentage =
            maxTotal > 0
                ? Math.round(
                    (
                        totalScore /
                        maxTotal
                    ) * 100
                )
                : 0;


        $("finalScore").textContent =
            totalScore;


        $("finalDenom").textContent =
            `/ ${maxTotal}`;


        $("finalPercentage").textContent =
            `${percentage}%`;


        $("finalQuestionCount").textContent =
            interviewResults.length;


        renderSummary();


        showScreen(
            resultScreen
        );


    } finally {

        setLoading(false);

    }
}


// ============================================================
// FINAL SUMMARY
// ============================================================

function renderSummary() {

    const container =
        $("summaryList");


    container.innerHTML =
        "";


    interviewResults.forEach(
        (item, index) => {

            const row =
                document.createElement(
                    "div"
                );


            row.className =
                "summary-item";


            row.innerHTML = `
                <div class="summary-index">
                    ${String(index + 1).padStart(2, "0")}
                </div>

                <div class="summary-question">
                    ${escapeHtml(item.question)}
                </div>

                <div class="summary-score">
                    ${item.score}/${item.max_score}
                </div>
            `;


            container.appendChild(
                row
            );
        }
    );
}


// ============================================================
// ESCAPE HTML
// ============================================================

function escapeHtml(value) {

    return String(value)

        .replaceAll(
            "&",
            "&amp;"
        )

        .replaceAll(
            "<",
            "&lt;"
        )

        .replaceAll(
            ">",
            "&gt;"
        )

        .replaceAll(
            '"',
            "&quot;"
        )

        .replaceAll(
            "'",
            "&#039;"
        );
}


// ============================================================
// RESET / NEW INTERVIEW
// ============================================================

$("restartBtn").addEventListener(
    "click",
    resetApplication
);


$("resultRestartBtn").addEventListener(
    "click",
    resetApplication
);


function resetApplication() {

    if (isListening) {

        stopRecognition();

    }


    if (
        "speechSynthesis" in window
    ) {

        window.speechSynthesis.cancel();

    }


    questions = [];

    currentQuestionIndex = 0;

    interviewResults = [];

    analysisData = null;


    resumeInput.value =
        "";


    selectedFile.textContent =
        "No file selected";


    analyzeBtn.disabled =
        true;


    uploadError.classList.add(
        "hidden"
    );


    $("evaluationCard").classList.add(
        "hidden"
    );


    showScreen(
        uploadScreen
    );
}


// ============================================================
// BACKEND HEALTH CHECK
// ============================================================

async function checkBackend() {

    if (!API_BASE) {
        $("serverStatus").innerHTML = `
            <span class="status-dot needs-config"></span>
            Backend URL needed
        `;
        return;
    }

    try {

        const response = await fetch(`${API_BASE}/`);

        if (!response.ok) {
            throw new Error("Backend health check failed");
        }

        $("serverStatus").innerHTML = `
            <span class="status-dot"></span>
            Backend connected
        `;

    } catch {

        $("serverStatus").innerHTML = `
            <span class="status-dot offline"></span>
            Backend offline
        `;
    }
}


// ============================================================
// INITIALIZE
// ============================================================

setupSpeechRecognition();

checkBackend();