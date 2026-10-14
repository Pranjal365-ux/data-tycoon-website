"""Game rules shared by every API entry point.

This module holds the payout ranking (the "answer key"). It lives under api/,
which is never served as static content, so players cannot read it from the
browser. Keep it out of public/.
"""

from __future__ import annotations

import math
from fractions import Fraction

ROUNDS = 4
BASE_BUDGET = 1_000_000
ROUND_BONUS = 250_000  # default amount when organizers turn the between-round bonus on
MIN_ALLOCATION = 1_000
INDUSTRY_CAPACITY = 20
FLASH_DURATION_MS = 5 * 60 * 1000
ROUND_WAIT_MS = 30 * 60 * 1000

INDUSTRIES = ["Food", "Electronics", "Travel and Auto", "Pharma", "Education"]

INDUSTRY_DESCRIPTIONS = {
    "Food": "A hungry market shaped by changing tastes, supply chains, and consumer demand.",
    "Electronics": "A fast-moving industry driven by innovation, components, technology, and demand.",
    "Travel and Auto": "A market influenced by fuel prices, mobility, tourism, and consumer confidence.",
    "Pharma": "A regulated industry balancing research, manufacturing, trust, and accessibility.",
    "Education": "A knowledge-driven sector affected by technology, access, demand, and regulation.",
}

COMMON_PARAMETERS = [
    "R&D & Innovation",
    "Marketing & Sales",
    "Supply Chain & Logistics",
    "Technology & Digitalization",
    "Workforce & Talent",
]

PARAMETERS = {
    "Food": [*COMMON_PARAMETERS, "Procurement & Sourcing", "Production & Manufacturing", "Quality Control & Food Safety", "Demand & Inventory Management", "Product & Revenue Management"],
    "Electronics": [*COMMON_PARAMETERS, "Semiconductor & Chip Technology", "Component Manufacturing", "Memory & Storage", "Device Assembly", "Advanced Materials & Thermal Systems"],
    "Travel and Auto": [*COMMON_PARAMETERS, "Vehicle Manufacturing", "Energy & Propulsion", "Vehicle Technology", "Dealership & Distribution", "Tourism & Aviation"],
    "Pharma": [*COMMON_PARAMETERS, "Clinical Trials", "Drug Manufacturing", "Quality Control & Compliance", "Hospital & Care Network", "Medical Devices & Digital Care"],
    "Education": [*COMMON_PARAMETERS, "Faculty Development", "Curriculum & Content", "Industry Partnerships", "Student Services & Admissions", "Assessment & Certification"],
}

# Base multiplier of every parameter in Rounds 1, 2, 3 and 4, per industry.
# This is the answer key: it must match the organizers' multiplier sheet cell for cell.
# Each round uses every value of RANK_MULTIPLIERS exactly once (checked below).
BASE_MULTIPLIERS = {
    "Food": {
        "R&D & Innovation": (1.5, 0.5, 0.5, 0.5),
        "Marketing & Sales": (0.3, 1.0, 1.5, 0.8),
        "Supply Chain & Logistics": (1.8, 2.7, 1.2, 0.0),
        "Technology & Digitalization": (1.0, 0.8, 0.3, 1.2),
        "Workforce & Talent": (0.0, 0.0, 0.0, 0.3),
        "Procurement & Sourcing": (0.5, 0.7, 1.0, 2.7),
        "Production & Manufacturing": (2.7, 1.2, 0.8, 1.5),
        "Quality Control & Food Safety": (1.2, 1.5, 1.8, 0.7),
        "Demand & Inventory Management": (0.8, 1.8, 2.7, 1.0),
        "Product & Revenue Management": (0.7, 0.3, 0.7, 1.8),
    },
    "Electronics": {
        "R&D & Innovation": (1.5, 1.0, 2.7, 1.8),
        "Marketing & Sales": (0.3, 0.7, 1.5, 0.8),
        "Supply Chain & Logistics": (0.0, 0.5, 1.0, 0.0),
        "Technology & Digitalization": (1.0, 2.7, 0.5, 1.0),
        "Workforce & Talent": (0.5, 0.8, 0.3, 0.3),
        "Semiconductor & Chip Technology": (1.2, 1.8, 0.8, 2.7),
        "Component Manufacturing": (0.8, 0.0, 1.2, 0.7),
        "Memory & Storage": (2.7, 1.2, 0.7, 1.2),
        "Device Assembly": (0.7, 0.3, 1.8, 1.5),
        "Advanced Materials & Thermal Systems": (1.8, 1.5, 0.0, 0.5),
    },
    "Travel and Auto": {
        "R&D & Innovation": (1.5, 0.5, 0.5, 0.5),
        "Marketing & Sales": (0.3, 0.7, 2.7, 0.8),
        "Supply Chain & Logistics": (1.0, 2.7, 1.0, 1.2),
        "Technology & Digitalization": (0.8, 1.2, 0.7, 1.0),
        "Workforce & Talent": (0.0, 0.8, 0.0, 0.3),
        "Vehicle Manufacturing": (1.8, 1.5, 1.2, 1.8),
        "Energy & Propulsion": (2.7, 0.3, 0.8, 1.5),
        "Vehicle Technology": (1.2, 1.0, 1.5, 0.7),
        "Dealership & Distribution": (0.7, 1.8, 1.8, 2.7),
        "Tourism & Aviation": (0.5, 0.0, 0.3, 0.0),
    },
    "Pharma": {
        "R&D & Innovation": (2.7, 0.3, 0.5, 1.8),
        "Marketing & Sales": (1.2, 0.7, 1.5, 0.8),
        "Supply Chain & Logistics": (0.5, 2.7, 1.2, 0.0),
        "Technology & Digitalization": (0.3, 1.2, 0.8, 1.0),
        "Workforce & Talent": (0.0, 0.0, 0.0, 0.3),
        "Clinical Trials": (1.0, 0.8, 0.7, 0.5),
        "Drug Manufacturing": (0.8, 1.0, 1.8, 2.7),
        "Quality Control & Compliance": (1.5, 1.8, 2.7, 1.2),
        "Hospital & Care Network": (0.7, 1.5, 1.0, 1.5),
        "Medical Devices & Digital Care": (1.8, 0.5, 0.3, 0.7),
    },
    "Education": {
        "R&D & Innovation": (2.7, 1.2, 2.7, 1.2),
        "Marketing & Sales": (0.0, 0.3, 1.8, 0.7),
        "Supply Chain & Logistics": (0.5, 0.5, 0.5, 0.3),
        "Technology & Digitalization": (1.5, 0.0, 1.5, 0.5),
        "Workforce & Talent": (1.0, 1.0, 0.3, 1.0),
        "Faculty Development": (0.8, 0.8, 0.8, 0.8),
        "Curriculum & Content": (1.8, 2.7, 1.0, 2.7),
        "Industry Partnerships": (1.2, 1.8, 1.2, 1.8),
        "Student Services & Admissions": (0.7, 0.7, 0.7, 0.0),
        "Assessment & Certification": (0.3, 1.5, 0.0, 1.5),
    },
}
RANK_MULTIPLIERS = [2.7, 1.8, 1.5, 1.2, 1.0, 0.8, 0.7, 0.5, 0.3, 0.0]


def _check_answer_key() -> None:
    """Refuse to start with a malformed answer key."""
    for industry, table in BASE_MULTIPLIERS.items():
        if set(table) != set(PARAMETERS[industry]):
            raise ValueError(f"{industry}: multiplier table does not list exactly its ten parameters")
        for round_index in range(ROUNDS):
            column = sorted((values[round_index] for values in table.values()), reverse=True)
            if column != RANK_MULTIPLIERS:
                raise ValueError(f"{industry} round {round_index + 1}: must use each base multiplier exactly once")


_check_answer_key()

# Parameters ordered from best to worst return, per industry and round (derived).
RANKS = {
    industry: [sorted(table, key=lambda name: -table[name][round_index]) for round_index in range(ROUNDS)]
    for industry, table in BASE_MULTIPLIERS.items()
}
DATASET_SLUGS = {"Food": "food", "Electronics": "electronics", "Travel and Auto": "travel-auto", "Pharma": "pharma", "Education": "education"}


def base_multipliers(industry: str, round_number: int) -> dict[str, float]:
    return {parameter: values[round_number - 1] for parameter, values in BASE_MULTIPLIERS[industry].items()}


# Effective multiplier by allocation band, exactly as in the organizers' multiplier sheet.
# Bands: up to 20%, over 20 to 40%, over 40 to 60%, over 60 to 80%, over 80%.
# A share exactly on 20/40/60/80% stays in the lower band.
BANDS = {
    2.7: (2.16, 2.7, 2.43, 1.89, 1.62),
    1.8: (1.8, 1.8, 1.62, 1.26, 1.08),
    1.5: (1.5, 1.5, 1.35, 1.05, 0.9),
    1.2: (1.2, 1.2, 1.08, 0.84, 0.72),
    1.0: (1.0, 1.0, 1.0, 1.0, 1.0),
    0.8: (0.8, 0.8, 0.8, 0.8, 0.8),
    0.7: (0.7, 0.7, 0.7, 0.7, 0.7),
    0.5: (0.5, 0.5, 0.5, 0.5, 0.5),
    0.3: (0.3, 0.3, -0.9, -0.9, -0.9),
    0.0: (0.0, 0.0, 0.0, 0.0, 0.0),
}


def band_index(percentage: float) -> int:
    if percentage <= 20:
        return 0
    if percentage <= 40:
        return 1
    if percentage <= 60:
        return 2
    if percentage <= 80:
        return 3
    return 4


def effective_multiplier(base: float, percentage: float) -> tuple[float, bool]:
    """Apply the allocation bands. Returns (multiplier, eliminated).

    Over 80% of the round's money in a 0.0 parameter eliminates the team.
    """
    index = band_index(percentage)
    return BANDS[base][index], base == 0.0 and index == 4


def validate_allocations(industry: str, budget: int, allocations) -> tuple[dict[str, int] | None, str]:
    """Return (clean allocations, "") or (None, error message)."""
    if not isinstance(allocations, dict):
        return None, "Allocations are missing."
    parameters = PARAMETERS[industry]
    clean: dict[str, int] = {}
    for name in parameters:
        value = allocations.get(name)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value != int(value):
            return None, f"Enter a whole rupee amount for {name}."
        if value < MIN_ALLOCATION:
            return None, f"{name} needs at least ₹{MIN_ALLOCATION:,}."
        clean[name] = int(value)
    if set(allocations) - set(parameters):
        return None, "Allocations include an unknown parameter."
    total = sum(clean.values())
    if total != budget:
        return None, f"Allocations must total exactly ₹{budget:,} (currently ₹{total:,})."
    return clean, ""


def round_half_up(value: float) -> int:
    """Match JavaScript's Math.round (Python's round() rounds halves to even)."""
    return math.floor(value + 0.5)


def score_round(industry: str, round_number: int, budget: int, allocations: dict[str, int]) -> dict:
    multipliers = base_multipliers(industry, round_number)
    returns: dict[str, float] = {}
    eliminated = False
    total = 0.0
    for name, amount in allocations.items():
        # Exact share (no floating point), so exactly 20/40/60/80% always stays in the lower band.
        multiplier, knocked_out = effective_multiplier(multipliers[name], Fraction(amount * 100, budget))
        eliminated = eliminated or knocked_out
        returns[name] = amount * multiplier
        total += returns[name]
    payout = 0 if eliminated else round_half_up(total)
    return {
        "payout": payout,
        "returns": {name: (0 if eliminated else round_half_up(value)) for name, value in returns.items()},
        "eliminated": eliminated,
        "netProfit": payout - budget,
    }


def dataset_filename(industry: str, round_number: int) -> str:
    slug = DATASET_SLUGS[industry]
    extension = "xlsx" if slug == "food" and round_number <= 2 else "csv"
    return f"flash{round_number}/{slug}.{extension}"
