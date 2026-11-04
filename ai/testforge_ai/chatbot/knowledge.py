"""Load the version-controlled knowledge base. A document that fails a check is never served."""

from importlib import resources

from testforge_ai.chatbot.models import KnowledgeBase, KnowledgeDocument
from testforge_ai.safety import scan_exfiltration, scan_injection


class KnowledgeBaseError(Exception):
    pass


def load_knowledge_base() -> KnowledgeBase:
    raw = resources.files("testforge_ai.data").joinpath("faq.json").read_text(encoding="utf-8")
    kb = KnowledgeBase.model_validate_json(raw)
    ids = [doc.id for doc in kb.documents]
    if len(ids) != len(set(ids)):
        raise KnowledgeBaseError("Document ids must be unique")
    unsafe = [doc.id for doc in kb.documents if is_poisoned(doc)]
    if unsafe:
        raise KnowledgeBaseError(f"Documents look like instructions: {unsafe}")
    return kb


def is_poisoned(doc: KnowledgeDocument) -> bool:
    text = f"{doc.title} {doc.text}"
    return bool(scan_injection(text) or scan_exfiltration(text))
