"""Deterministic checks on untrusted text.

Pattern matching catches common attacks and misses reworded ones, so it is one layer only. What
actually limits the damage is structural: output is validated, citations are checked against
evidence, nothing generated is executed, and authorization happens in the backend.
"""

import re
import unicodedata
from urllib.parse import urlparse

_INVISIBLE = {"Cc", "Cf", "Co", "Cs"}
_KEPT_CONTROLS = {"\n", "\t"}


def normalize_untrusted(text: str) -> str:
    """Fold look-alike characters and remove invisible ones that can hide an instruction."""
    folded = unicodedata.normalize("NFKC", text)
    cleaned = "".join(
        char
        for char in folded
        if char in _KEPT_CONTROLS or unicodedata.category(char) not in _INVISIBLE
    )
    return re.sub(r"[ \t]+", " ", cleaned).strip()


_FLAGS = re.IGNORECASE | re.DOTALL
INJECTION_RULES: dict[str, re.Pattern[str]] = {
    "ignore_instructions": re.compile(
        r"\b(ignore|disregard|forget|override|overrule|bypass|skip)\b.{0,50}?"
        r"\b(instruction|prompt|rule|polic(y|ies)|guideline|direction|guardrail|restriction)s?\b",
        _FLAGS,
    ),
    "role_override": re.compile(
        r"\b(you are now|you're now|act as|pretend (to be|you are|that you)|role-?play|"
        r"from now on|new instructions?|developer mode|debug mode|admin mode|jailbreak|"
        r"no restrictions)\b",
        _FLAGS,
    ),
    "prompt_extraction": re.compile(
        r"\b(system|hidden|initial|original|developer|internal)\s+"
        r"(prompt|message|instruction|configuration|rule)s?\b|"
        r"\b(reveal|show|print|repeat|dump|output|tell me)\b.{0,30}?"
        r"\b(your|the)\s+(prompt|instructions|configuration|rules)\b",
        _FLAGS,
    ),
    "fake_delimiter": re.compile(
        r"</?\s*(system|assistant|developer|evidence|instructions?)\s*>|"
        r"\[\s*/?(system|inst)\s*\]|\"role\"\s*:\s*\"(system|developer)\"|"
        r"^\s*(system|assistant)\s*:",
        _FLAGS | re.MULTILINE,
    ),
    "forced_output": re.compile(
        r"\b(respond|reply|answer|say|output|print|state)\b\s+(only\s+)?(with\s+)?(exactly\s+)?"
        r"(the\s+(word|phrase|sentence)\s+)?[\"'“‘]",
        _FLAGS,
    ),
    "authority_claim": re.compile(
        r"\b(i am|i'm|this is)\s+(the\s+|an?\s+|your\s+)?"
        r"(admin|administrator|developer|system|ceo|owner|openai|support manager)\b.{0,60}?"
        r"\b(so|must|have to|authorize|authorise|approve|override|tell|give|show)\b",
        _FLAGS,
    ),
}

EXFILTRATION_RULES: dict[str, re.Pattern[str]] = {
    "credentials": re.compile(
        r"\b(api|secret|access|session|bearer)[\s_-]*(key|token|cookie)s?\b|"
        r"\b(env|environment)\s+variables?\b|\bdatabase\s+(url|credentials|password|dump)\b|"
        r"\bconnection\s+string\b|\bpassword\s+hash(es)?\b",
        _FLAGS,
    ),
    "other_customers": re.compile(
        r"\b(other|another|all|every|different)\s+(\w+\s+)?"
        r"(customers?|users?|accounts?|buyers?|compan(y|ies))\b.{0,40}?"
        r"\b(order|email|address|data|password|detail|invoice|record|payment|phone)s?\b|"
        r"\b(show|give|list|get|tell|send|export|display|find)\b.{0,20}?"
        r"\b(order|email|address|data|password|detail|invoice|record|payment|phone)s?\b.{0,30}?"
        r"\b(other|another|every|different)\s+(\w+\s+)?(customers?|users?|accounts?|buyers?)\b|"
        r"\b(list|export|dump|give me|show me)\b.{0,20}?\b(all|every)\s+"
        r"(customers?|users?|orders?|emails?)\b",
        _FLAGS,
    ),
    "send_elsewhere": re.compile(
        r"\b(send|forward|post|upload|email)\b.{0,50}?"
        r"(https?://|\b[\w.+-]+@(?!testforge\.example\b)[\w-]+\.\w+)",
        _FLAGS,
    ),
}


def scan_injection(text: str) -> list[str]:
    normalized = normalize_untrusted(text)
    return [name for name, rule in INJECTION_RULES.items() if rule.search(normalized)]


def scan_exfiltration(text: str) -> list[str]:
    normalized = normalize_untrusted(text)
    return [name for name, rule in EXFILTRATION_RULES.items() if rule.search(normalized)]


_LOCAL_HOSTS = ("localhost", "127.0.0.1")
_URL = re.compile(r"https?://[^\s\"'<>)]+", re.IGNORECASE)
_UNSAFE_CONTENT: dict[str, re.Pattern[str]] = {
    "shell_command": re.compile(
        r"\b(rm\s+-[a-z]*[rf]|curl\s|wget\s|chmod\s|sudo\s|nc\s+-|bash\s+-c|powershell)", re.I
    ),
    "code_execution": re.compile(
        r"\b(eval|exec|execSync|spawn|Function)\s*\(|child_process|subprocess|os\.system|"
        r"process\.env|require\s*\(|import\s*\(|__import__",
        re.I,
    ),
    "markup": re.compile(r"<\s*(script|iframe|img|svg)\b|javascript:", re.I),
    "secrets": re.compile(r"\b(api[_ -]?key|secret[_ -]?key|bearer\s+\w+|sk-[a-z0-9]{8,})", re.I),
}


def scan_unsafe_content(text: str) -> list[str]:
    """Generated test text describes behaviour, so commands, code and outside URLs do not belong."""
    found = [name for name, rule in _UNSAFE_CONTENT.items() if rule.search(text)]
    for url in _URL.findall(text):
        host = urlparse(url).hostname or ""
        if host not in _LOCAL_HOSTS and not host.endswith(".example"):
            found.append("external_url")
            break
    return found


_REDACTIONS = [
    (re.compile(r"(?i)\b(set-cookie|cookie|authorization)\b(\s*[:=]\s*)[^\n]+"), r"\1\2[REDACTED]"),
    (re.compile(r"(?i)\b(bearer)\s+[a-z0-9._~+/=-]{8,}"), r"\1 [REDACTED]"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{8,}"), "[REDACTED]"),
    (re.compile(r"(?i)(testforge_session=)[^;\s\"]+"), r"\1[REDACTED]"),
    (
        re.compile(r"(?i)(\"?(?:password|token|secret|api_?key)\"?\s*[:=]\s*)\"?[^\s\",}]+\"?"),
        r"\1[REDACTED]",
    ),
    (re.compile(r"(/(?:Users|home)/)[^/\s]+"), r"\1[USER]"),
    (re.compile(r"(?i)(postgres(?:ql)?(?:\+\w+)?://[^:\s/]+:)[^@\s]+(@)"), r"\1[REDACTED]\2"),
]


def redact(text: str) -> str:
    """Remove credentials from artifact text before it is stored or sent anywhere."""
    for pattern, replacement in _REDACTIONS:
        text = pattern.sub(replacement, text)
    return text
