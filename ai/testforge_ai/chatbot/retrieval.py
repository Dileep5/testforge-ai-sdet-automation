"""Plain BM25 over a few dozen short documents. No embeddings: results can be read and explained."""

import math
import re
from collections import Counter
from dataclasses import dataclass

from testforge_ai.chatbot.models import KnowledgeDocument

_K1 = 1.2
_B = 0.75

STOPWORDS = frozenset(
    [
        "a",
        "about",
        "after",
        "all",
        "also",
        "am",
        "an",
        "and",
        "any",
        "are",
        "as",
        "at",
        "back",
        "be",
        "been",
        "before",
        "being",
        "but",
        "by",
        "can",
        "could",
        "did",
        "do",
        "does",
        "doing",
        "for",
        "from",
        "get",
        "gets",
        "give",
        "got",
        "had",
        "has",
        "have",
        "how",
        "i",
        "if",
        "in",
        "into",
        "is",
        "it",
        "its",
        "just",
        "know",
        "let",
        "like",
        "long",
        "make",
        "may",
        "me",
        "might",
        "much",
        "must",
        "my",
        "need",
        "needs",
        "no",
        "not",
        "of",
        "off",
        "on",
        "one",
        "or",
        "our",
        "out",
        "over",
        "please",
        "shall",
        "should",
        "so",
        "some",
        "tell",
        "than",
        "that",
        "the",
        "their",
        "them",
        "then",
        "there",
        "these",
        "they",
        "this",
        "those",
        "to",
        "too",
        "up",
        "us",
        "was",
        "we",
        "well",
        "were",
        "what",
        "when",
        "where",
        "which",
        "who",
        "why",
        "will",
        "with",
        "would",
        "yes",
        "you",
        "your",
        "happens",
        "happen",
        "mean",
        "means",
        "want",
        "wants",
        "take",
        "takes",
    ]
)

# Words for the same idea, set against the development split only.
_SYNONYMS = {
    "money": "refund",
    "reimburse": "refund",
    "repay": "refund",
    "reimbursement": "refund",
    "send": "return",
    "exchange": "return",
    "deliver": "ship",
    "delivery": "ship",
    "shipment": "ship",
    "shipping": "ship",
    "arrive": "ship",
    "internationally": "international",
    "country": "international",
    "countries": "international",
    "deadline": "window",
    "abroad": "international",
    "overseas": "international",
    "foreign": "international",
    "stock": "inventory",
    "available": "inventory",
    "availability": "inventory",
    "quantity": "inventory",
    "signin": "sign",
    "login": "sign",
    "log": "sign",
    "logged": "sign",
    "credentials": "password",
    "forgot": "reset",
    "forgotten": "reset",
    "change": "change",
    "modify": "change",
    "edit": "change",
    "alter": "change",
    "amend": "change",
    "broken": "damage",
    "damaged": "damage",
    "defective": "damage",
    "wrong": "incorrect",
    "abort": "cancel",
    "void": "cancel",
    "stop": "cancel",
    "fast": "expedite",
    "faster": "expedite",
    "rush": "expedite",
    "quick": "expedite",
    "expedited": "expedite",
    "reach": "contact",
    "email": "contact",
    "phone": "contact",
    "disabled": "deactivate",
    "deactivated": "deactivate",
    "permission": "role",
    "permissions": "role",
    "backorder": "backorder",
    "backorders": "backorder",
    "duration": "time",
    "timing": "time",
}


def _stem(word: str) -> str:
    for suffix, minimum in (("ing", 6), ("ed", 5), ("es", 5), ("s", 4)):
        if word.endswith(suffix) and len(word) >= minimum:
            return word[: -len(suffix)]
    return word


def tokenize(text: str) -> list[str]:
    tokens = []
    for word in re.findall(r"[a-z0-9]+", text.lower()):
        if word in STOPWORDS or len(word) == 1:
            continue
        mapped = _SYNONYMS.get(word, word)
        stem = _stem(mapped)
        tokens.append(_SYNONYMS.get(stem, stem))
    return tokens


@dataclass(frozen=True)
class Hit:
    document: KnowledgeDocument
    score: float
    coverage: float


class Retriever:
    def __init__(self, documents: list[KnowledgeDocument]) -> None:
        self.documents = documents
        # The title counts twice: it says what the document is about.
        self._terms = [
            Counter(tokenize(f"{doc.title} {doc.title} {doc.text}")) for doc in documents
        ]
        self._lengths = [sum(terms.values()) for terms in self._terms]
        self._average = sum(self._lengths) / max(len(self._lengths), 1)
        frequency: Counter[str] = Counter()
        for terms in self._terms:
            frequency.update(terms.keys())
        total = len(documents)
        self._idf = {
            term: math.log(1 + (total - count + 0.5) / (count + 0.5))
            for term, count in frequency.items()
        }

    def search(self, query: str, limit: int = 4) -> tuple[list[Hit], list[str]]:
        """Return hits, best first, and the query's content terms."""
        query_terms = list(dict.fromkeys(tokenize(query)))
        hits = []
        for doc, terms, length in zip(self.documents, self._terms, self._lengths, strict=True):
            score = 0.0
            matched = 0
            for term in query_terms:
                count = terms.get(term, 0)
                if not count:
                    continue
                matched += 1
                norm = count + _K1 * (1 - _B + _B * length / self._average)
                score += self._idf[term] * count * (_K1 + 1) / norm
            if score > 0:
                hits.append(Hit(doc, score, matched / len(query_terms)))
        # The id breaks ties, so the order never depends on anything but the data.
        hits.sort(key=lambda hit: (-hit.score, hit.document.id))
        return hits[:limit], query_terms
