"""Game rules shared by every API entry point.

This module holds the payout ranking (the "answer key"). It lives under api/,
which is never served as static content, so players cannot read it from the
browser. Keep it out of public/.
"""

from __future__ import annotations

import math

ROUNDS = 4
BASE_BUDGET = 1_000_000
ROUND_BONUS = 250_000
BONUS_ROUNDS = {2, 3}
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

# Parameters ordered from best to worst return, per industry and flash round.
RANKS = {
    "Food": [
        ["Production & Manufacturing", "Supply Chain & Logistics", "R&D & Innovation", "Quality Control & Food Safety", "Technology & Digitalization", "Demand & Inventory Management", "Product & Revenue Management", "Procurement & Sourcing", "Marketing & Sales", "Workforce & Talent"],
        ["Supply Chain & Logistics", "Demand & Inventory Management", "Quality Control & Food Safety", "Production & Manufacturing", "Marketing & Sales", "Technology & Digitalization", "Procurement & Sourcing", "R&D & Innovation", "Product & Revenue Management", "Workforce & Talent"],
        ["Demand & Inventory Management", "Quality Control & Food Safety", "Marketing & Sales", "Supply Chain & Logistics", "Procurement & Sourcing", "Production & Manufacturing", "Product & Revenue Management", "R&D & Innovation", "Technology & Digitalization", "Workforce & Talent"],
        ["Procurement & Sourcing", "Product & Revenue Management", "Production & Manufacturing", "Technology & Digitalization", "Demand & Inventory Management", "Marketing & Sales", "Quality Control & Food Safety", "R&D & Innovation", "Workforce & Talent", "Supply Chain & Logistics"],
    ],
    "Electronics": [
        ["Memory & Storage", "Advanced Materials & Thermal Systems", "R&D & Innovation", "Semiconductor & Chip Technology", "Technology & Digitalization", "Component Manufacturing", "Device Assembly", "Workforce & Talent", "Marketing & Sales", "Supply Chain & Logistics"],
        ["Technology & Digitalization", "Semiconductor & Chip Technology", "Advanced Materials & Thermal Systems", "Memory & Storage", "R&D & Innovation", "Workforce & Talent", "Marketing & Sales", "Supply Chain & Logistics", "Device Assembly", "Component Manufacturing"],
        ["R&D & Innovation", "Device Assembly", "Marketing & Sales", "Component Manufacturing", "Supply Chain & Logistics", "Semiconductor & Chip Technology", "Memory & Storage", "Technology & Digitalization", "Workforce & Talent", "Advanced Materials & Thermal Systems"],
        ["Semiconductor & Chip Technology", "R&D & Innovation", "Device Assembly", "Memory & Storage", "Technology & Digitalization", "Marketing & Sales", "Component Manufacturing", "Advanced Materials & Thermal Systems", "Workforce & Talent", "Supply Chain & Logistics"],
    ],
    "Education": [
        ["R&D & Innovation", "Curriculum & Content", "Technology & Digitalization", "Industry Partnerships", "Workforce & Talent", "Faculty Development", "Student Services & Admissions", "Supply Chain & Logistics", "Assessment & Certification", "Marketing & Sales"],
        ["Curriculum & Content", "Industry Partnerships", "Assessment & Certification", "R&D & Innovation", "Workforce & Talent", "Faculty Development", "Student Services & Admissions", "Supply Chain & Logistics", "Marketing & Sales", "Technology & Digitalization"],
        ["R&D & Innovation", "Marketing & Sales", "Technology & Digitalization", "Industry Partnerships", "Curriculum & Content", "Faculty Development", "Student Services & Admissions", "Supply Chain & Logistics", "Workforce & Talent", "Assessment & Certification"],
        ["Curriculum & Content", "Assessment & Certification", "Student Services & Admissions", "R&D & Innovation", "Technology & Digitalization", "Faculty Development", "Marketing & Sales", "Industry Partnerships", "Workforce & Talent", "Supply Chain & Logistics"],
    ],
    "Pharma": [
        ["R&D & Innovation", "Medical Devices & Digital Care", "Quality Control & Compliance", "Marketing & Sales", "Clinical Trials", "Drug Manufacturing", "Hospital & Care Network", "Supply Chain & Logistics", "Technology & Digitalization", "Workforce & Talent"],
        ["Supply Chain & Logistics", "Quality Control & Compliance", "Hospital & Care Network", "Technology & Digitalization", "Drug Manufacturing", "Clinical Trials", "Marketing & Sales", "Medical Devices & Digital Care", "R&D & Innovation", "Workforce & Talent"],
        ["Quality Control & Compliance", "Drug Manufacturing", "Marketing & Sales", "Supply Chain & Logistics", "Hospital & Care Network", "Technology & Digitalization", "Clinical Trials", "R&D & Innovation", "Medical Devices & Digital Care", "Workforce & Talent"],
        ["Drug Manufacturing", "R&D & Innovation", "Hospital & Care Network", "Quality Control & Compliance", "Technology & Digitalization", "Marketing & Sales", "Medical Devices & Digital Care", "Clinical Trials", "Workforce & Talent", "Supply Chain & Logistics"],
    ],
    "Travel and Auto": [
        ["Energy & Propulsion", "Vehicle Manufacturing", "R&D & Innovation", "Vehicle Technology", "Supply Chain & Logistics", "Technology & Digitalization", "Dealership & Distribution", "Tourism & Aviation", "Marketing & Sales", "Workforce & Talent"],
        ["Supply Chain & Logistics", "Dealership & Distribution", "Vehicle Manufacturing", "Technology & Digitalization", "Vehicle Technology", "Workforce & Talent", "Marketing & Sales", "R&D & Innovation", "Energy & Propulsion", "Tourism & Aviation"],
        ["Marketing & Sales", "Dealership & Distribution", "Vehicle Technology", "Vehicle Manufacturing", "Supply Chain & Logistics", "Energy & Propulsion", "Technology & Digitalization", "R&D & Innovation", "Tourism & Aviation", "Workforce & Talent"],
        ["Marketing & Sales", "Dealership & Distribution", "Vehicle Technology", "Vehicle Manufacturing", "Supply Chain & Logistics", "Energy & Propulsion", "Technology & Digitalization", "R&D & Innovation", "Workforce & Talent", "Tourism & Aviation"],
    ],
}
RANK_MULTIPLIERS = [2.7, 1.8, 1.5, 1.2, 1.0, 0.8, 0.7, 0.5, 0.3, 0.0]
DATASET_SLUGS = {"Food": "food", "Electronics": "electronics", "Travel and Auto": "travel-auto", "Pharma": "pharma", "Education": "education"}


def round_bonus(round_number: int) -> int:
    return ROUND_BONUS if round_number in BONUS_ROUNDS else 0


def base_multipliers(industry: str, round_number: int) -> dict[str, float]:
    ranking = RANKS[industry][round_number - 1]
    return {parameter: RANK_MULTIPLIERS[rank] for rank, parameter in enumerate(ranking)}


def effective_multiplier(base: float, percentage: float) -> tuple[float, bool]:
    """Apply the allocation bands. Returns (multiplier, eliminated)."""
    if base == 0:
        return 0.0, percentage > 80
    if base == 0.3:
        return (-0.9 if percentage > 40 else 0.3), False
    if base in (1.0, 0.8, 0.7, 0.5):
        return base, False
    if base == 2.7:
        if percentage <= 20:
            return 2.7 * 0.8, False
        if percentage <= 40:
            return 2.7, False
        if percentage <= 60:
            return 2.7 * 0.9, False
        if percentage <= 80:
            return 2.7 * 0.7, False
        return 2.7 * 0.6, False
    if base in (1.8, 1.5, 1.2):
        if percentage <= 40:
            return base, False
        if percentage <= 60:
            return base * 0.9, False
        if percentage <= 80:
            return base * 0.7, False
        return base * 0.6, False
    return base, False


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
        multiplier, knocked_out = effective_multiplier(multipliers[name], amount / budget * 100)
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
