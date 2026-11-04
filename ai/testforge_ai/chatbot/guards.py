"""Rule-based checks on an answer and its citations. They run on every answer, however produced.

These catch invented numbers, fake citations and leaks. They compare words, not meaning, so a
well-worded false claim built from the source's own words could still pass.
"""

import re

from testforge_ai.chatbot.models import Citation, Evidence
from testforge_ai.chatbot.retrieval import tokenize

# Set against the development split: how many of a sentence's content words the quotes must contain.
MIN_SENTENCE_SUPPORT = 0.6
CANARY = "TF-CANARY-7Q2X"

_NUMBER = re.compile(r"\d+(?:[.,]\d+)*")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_URL = re.compile(r"https?://\S+", re.IGNORECASE)
_NEGATION = re.compile(r"\b(not|never|no|cannot|can't|won't|don't|doesn't|isn't|aren't)\b", re.I)
_LEAK = re.compile(r"\b(system prompt|my instructions|untrusted_data|api key)\b", re.IGNORECASE)
_NUMBER_WORDS = {
    "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
    "twelve", "thirty", "sixty", "ninety", "hundred",
}  # fmt: skip


def squeeze(text: str) -> str:
    return " ".join(text.split())


def sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", squeeze(text))
    return [part for part in parts if part]


def citation_problems(citations: list[Citation], evidence: list[Evidence]) -> list[str]:
    by_id = {item.source_id: item for item in evidence}
    problems = []
    for citation in citations:
        source = by_id.get(citation.source_id)
        if source is None:
            problems.append(f"citation_unknown_source:{citation.source_id}")
        elif squeeze(citation.quote) not in squeeze(source.text):
            problems.append(f"citation_quote_not_in_source:{citation.source_id}")
    return problems


def groundedness_problems(answer: str, citations: list[Citation]) -> list[str]:
    quotes = " ".join(citation.quote for citation in citations)
    quote_terms = set(tokenize(quotes))
    problems = []
    for number in sorted(set(_NUMBER.findall(answer)) - set(_NUMBER.findall(quotes))):
        problems.append(f"number_not_in_evidence:{number}")
    words = set(re.findall(r"[a-z]+", answer.lower()))
    for word in sorted((words & _NUMBER_WORDS) - set(re.findall(r"[a-z]+", quotes.lower()))):
        problems.append(f"number_not_in_evidence:{word}")
    for value in sorted(set(_EMAIL.findall(answer)) - set(_EMAIL.findall(quotes))):
        problems.append(f"email_not_in_evidence:{value}")
    if _URL.search(answer) and not _URL.search(quotes):
        problems.append("url_not_in_evidence")
    if _NEGATION.search(answer) and not _NEGATION.search(quotes):
        problems.append("negation_not_in_evidence")
    for sentence in sentences(answer):
        terms = set(tokenize(sentence))
        if terms and len(terms & quote_terms) / len(terms) < MIN_SENTENCE_SUPPORT:
            problems.append("sentence_not_supported")
            break
    return problems


def leak_problems(answer: str) -> list[str]:
    problems = []
    if CANARY in answer:
        problems.append("system_prompt_leak")
    if _LEAK.search(answer):
        problems.append("internal_term")
    return problems


def check_answer(answer: str, citations: list[Citation], evidence: list[Evidence]) -> list[str]:
    if not citations:
        return ["no_citations"]
    return (
        citation_problems(citations, evidence)
        + groundedness_problems(answer, citations)
        + leak_problems(answer)
    )
