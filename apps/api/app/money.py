"""Currency arithmetic. Amounts are always integer cents, never binary floats."""


def line_total_cents(quantity: int, unit_price_cents: int) -> int:
    return quantity * unit_price_cents


def tax_cents(subtotal_cents: int, tax_rate_bps: int) -> int:
    """Tax in cents, rounded half-up. Non-negative integers only, so no float can sneak in."""
    return (subtotal_cents * tax_rate_bps + 5000) // 10000


def format_decimal(cents: int) -> str:
    """Render cents as a plain decimal string, e.g. 123456 -> '1234.56'."""
    sign = "-" if cents < 0 else ""
    whole, fraction = divmod(abs(cents), 100)
    return f"{sign}{whole}.{fraction:02d}"
