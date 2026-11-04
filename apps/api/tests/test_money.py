import pytest

from app.money import format_decimal, line_total_cents, tax_cents


@pytest.mark.parametrize(
    ("subtotal", "bps", "expected"),
    [
        (0, 1300, 0),
        (10000, 1300, 1300),
        (3998, 1300, 520),  # 519.74 rounds up
        (50, 100, 1),  # exactly 0.5 cent rounds half-up
        (49, 100, 0),  # 0.49 cent rounds down
        (1999, 1498, 299),  # 299.45 rounds down
        (10000, 0, 0),
        (10_000_000_000_000, 1498, 1_498_000_000_000),  # no precision loss at large amounts
    ],
)
def test_tax_rounds_half_up_with_integers(subtotal, bps, expected):
    assert tax_cents(subtotal, bps) == expected
    assert isinstance(tax_cents(subtotal, bps), int)


def test_cents_stay_exact_where_binary_floats_drift():
    # 0.07 * 3 is 0.21000000000000002 as a float; integer cents have no such error.
    assert line_total_cents(3, 7) == 21
    assert sum(line_total_cents(1, 10) for _ in range(3)) == 30


@pytest.mark.parametrize(
    ("cents", "text"),
    [(0, "0.00"), (5, "0.05"), (100, "1.00"), (123456, "1234.56"), (-250, "-2.50")],
)
def test_format_decimal(cents, text):
    assert format_decimal(cents) == text
