// Replace the sample values here with your own dataset for each industry.
// Keep the field names consistent so the archive, market desk, and results can use them.
export const industryDatasets = {
  Food: {
    companyName: "Nova Foods",
    profile: "A regional food producer balancing fresh demand, dependable sourcing, and affordable prices.",
    history: [
      { quarter: "Q1 2025", revenue: "₹8.2 L", demand: 72, costs: 34, index: 96.4 },
      { quarter: "Q2 2025", revenue: "₹8.9 L", demand: 76, costs: 33, index: 98.1 },
      { quarter: "Q3 2025", revenue: "₹9.6 L", demand: 80, costs: 32, index: 101.2 },
      { quarter: "Q4 2025", revenue: "₹10.3 L", demand: 84, costs: 31, index: 104.7 }
    ],
    market: { inputCosts: "Rising", demand: "Strong", logistics: "Mixed signals", technology: "Stable" }
  },
  Electronics: {
    companyName: "Nova Electronics",
    profile: "A growing electronics maker exposed to component pricing, product cycles, and rapid innovation.",
    history: [
      { quarter: "Q1 2025", revenue: "₹12.4 L", demand: 68, costs: 41, index: 98.2 },
      { quarter: "Q2 2025", revenue: "₹13.1 L", demand: 73, costs: 39, index: 100.5 },
      { quarter: "Q3 2025", revenue: "₹14.8 L", demand: 79, costs: 38, index: 103.8 },
      { quarter: "Q4 2025", revenue: "₹16.2 L", demand: 86, costs: 36, index: 108.1 }
    ],
    market: { inputCosts: "Volatile", demand: "Accelerating", logistics: "Tight components", technology: "Fast-moving" }
  },
  "Travel and Auto": {
    companyName: "Nova Mobility",
    profile: "A mobility business navigating fuel prices, seasonal travel, vehicle demand, and service capacity.",
    history: [
      { quarter: "Q1 2025", revenue: "₹10.1 L", demand: 64, costs: 38, index: 94.8 },
      { quarter: "Q2 2025", revenue: "₹11.7 L", demand: 72, costs: 37, index: 98.6 },
      { quarter: "Q3 2025", revenue: "₹12.9 L", demand: 77, costs: 39, index: 100.2 },
      { quarter: "Q4 2025", revenue: "₹14.5 L", demand: 83, costs: 36, index: 105.4 }
    ],
    market: { inputCosts: "Fuel-sensitive", demand: "Seasonal", logistics: "Improving", technology: "EV transition" }
  },
  Pharma: {
    companyName: "Nova Pharma",
    profile: "A pharmaceutical company balancing research investment, reliable production, compliance, and access.",
    history: [
      { quarter: "Q1 2025", revenue: "₹15.2 L", demand: 74, costs: 43, index: 99.1 },
      { quarter: "Q2 2025", revenue: "₹15.8 L", demand: 78, costs: 42, index: 100.7 },
      { quarter: "Q3 2025", revenue: "₹17.1 L", demand: 82, costs: 40, index: 104.2 },
      { quarter: "Q4 2025", revenue: "₹18.6 L", demand: 87, costs: 39, index: 107.9 }
    ],
    market: { inputCosts: "Elevated", demand: "Steady", logistics: "Temperature-sensitive", technology: "Research-led" }
  },
  Education: {
    companyName: "Nova Learning",
    profile: "An education provider responding to learner needs, digital access, and changing skill requirements.",
    history: [
      { quarter: "Q1 2025", revenue: "₹6.8 L", demand: 70, costs: 29, index: 95.6 },
      { quarter: "Q2 2025", revenue: "₹7.4 L", demand: 75, costs: 30, index: 98.9 },
      { quarter: "Q3 2025", revenue: "₹8.5 L", demand: 81, costs: 28, index: 103.1 },
      { quarter: "Q4 2025", revenue: "₹9.7 L", demand: 88, costs: 27, index: 108.8 }
    ],
    market: { inputCosts: "Stable", demand: "Growing", logistics: "Digital-first", technology: "Rapid adoption" }
  }
};
