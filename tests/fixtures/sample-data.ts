/**
 * ============================================================================
 * TEST FIXTURES: SAMPLE DATA FILES
 * ============================================================================
 *
 * Provides sample data in various formats (CSV, JSON) that simulate real user
 * data inputs. These fixtures are used across multiple test phases:
 *
 * - Phase 1: TemplateService tests (file copying verification)
 * - Phase 3: DataParserService + DataAnalyzer tests (parsing + analysis)
 * - Phase 4: Chat iteration tests (data context in LLM prompts)
 * - Phase 5: End-to-end pipeline tests
 *
 * Each fixture includes:
 *   - The raw string content (as user would have in their file)
 *   - Expected parse results for assertion
 *   - Expected analysis output for DataAnalyzer assertions
 *
 * NAMING CONVENTION:
 *   SAMPLE_<DOMAIN>_<FORMAT> for raw content
 *   EXPECTED_<DOMAIN>_<ASPECT> for expected results
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// FINANCE: CSV format (12 rows, 6 columns)
// Simulates a bank transaction export
// ---------------------------------------------------------------------------
export const SAMPLE_FINANCE_CSV = `date,amount,category,description,account,type
2025-01-15,-42.50,groceries,Whole Foods Market,checking,debit
2025-01-15,5000.00,salary,Monthly Salary,checking,credit
2025-01-16,-1500.00,rent,Apartment Rent,checking,debit
2025-01-17,-15.99,subscriptions,Netflix,credit_card,debit
2025-01-18,-65.00,dining,Restaurant dinner,credit_card,debit
2025-01-20,-30.00,transport,Uber rides,credit_card,debit
2025-01-22,-120.00,shopping,Amazon order,credit_card,debit
2025-01-25,-85.00,utilities,Electric bill,checking,debit
2025-02-01,5000.00,salary,Monthly Salary,checking,credit
2025-02-02,-42.00,groceries,Trader Joes,checking,debit
2025-02-03,-15.99,subscriptions,Spotify,credit_card,debit
2025-02-05,-200.00,shopping,Best Buy electronics,credit_card,debit`;

export const EXPECTED_FINANCE_CSV_COLUMNS = [
  { name: 'date', inferredType: 'date' },
  { name: 'amount', inferredType: 'number' },
  { name: 'category', inferredType: 'enum' },
  { name: 'description', inferredType: 'string' },
  { name: 'account', inferredType: 'enum' },
  { name: 'type', inferredType: 'enum' },
];

export const EXPECTED_FINANCE_CSV_STATS = {
  rowCount: 12,
  columnCount: 6,
  amountMin: -1500.0,
  amountMax: 5000.0,
  categoryUniqueValues: [
    'groceries', 'salary', 'rent', 'subscriptions',
    'dining', 'transport', 'shopping', 'utilities',
  ],
  accountUniqueValues: ['checking', 'credit_card'],
  typeUniqueValues: ['debit', 'credit'],
};

// ---------------------------------------------------------------------------
// HEALTH: JSON format (10 records)
// Simulates Apple Health export data
// ---------------------------------------------------------------------------
export const SAMPLE_HEALTH_JSON = JSON.stringify([
  { date: '2025-10-01', steps: 8432, calories: 2145, sleep_hours: 7.5, heart_rate: 68, weight: 75.2 },
  { date: '2025-10-02', steps: 6200, calories: 1890, sleep_hours: 6.8, heart_rate: 72, weight: 75.3 },
  { date: '2025-10-03', steps: 10500, calories: 2400, sleep_hours: 8.0, heart_rate: 65, weight: 75.1 },
  { date: '2025-10-04', steps: 3200, calories: 1650, sleep_hours: 5.5, heart_rate: 78, weight: 75.4 },
  { date: '2025-10-05', steps: 9800, calories: 2300, sleep_hours: 7.2, heart_rate: 67, weight: 75.0 },
  { date: '2025-10-06', steps: 7100, calories: 2000, sleep_hours: 6.5, heart_rate: 70, weight: 75.2 },
  { date: '2025-10-07', steps: 11200, calories: 2550, sleep_hours: 7.8, heart_rate: 64, weight: 74.9 },
  { date: '2025-10-08', steps: 5400, calories: 1780, sleep_hours: 6.0, heart_rate: 74, weight: 75.3 },
  { date: '2025-10-09', steps: 8900, calories: 2200, sleep_hours: 7.0, heart_rate: 69, weight: 75.1 },
  { date: '2025-10-10', steps: 7600, calories: 2050, sleep_hours: 7.3, heart_rate: 71, weight: 75.0 },
]);

export const EXPECTED_HEALTH_JSON_COLUMNS = [
  { name: 'date', inferredType: 'date' },
  { name: 'steps', inferredType: 'number' },
  { name: 'calories', inferredType: 'number' },
  { name: 'sleep_hours', inferredType: 'number' },
  { name: 'heart_rate', inferredType: 'number' },
  { name: 'weight', inferredType: 'number' },
];

export const EXPECTED_HEALTH_JSON_STATS = {
  rowCount: 10,
  columnCount: 6,
  stepsMin: 3200,
  stepsMax: 11200,
  heartRateMin: 64,
  heartRateMax: 78,
};

// ---------------------------------------------------------------------------
// GROCERY: JSON format (nested structure)
// Simulates a grocery tracking app export
// ---------------------------------------------------------------------------
export const SAMPLE_GROCERY_JSON = JSON.stringify({
  trips: [
    {
      date: '2025-02-01',
      store: 'Whole Foods',
      items: [
        { name: 'Organic Bananas', category: 'Produce', quantity: 1, price: 2.49 },
        { name: 'Chicken Breast', category: 'Meat', quantity: 2, price: 8.99 },
        { name: 'Almond Milk', category: 'Dairy', quantity: 1, price: 3.99 },
      ],
      total: 24.46,
    },
    {
      date: '2025-02-05',
      store: 'Trader Joes',
      items: [
        { name: 'Pasta', category: 'Pantry', quantity: 3, price: 1.99 },
        { name: 'Tomato Sauce', category: 'Pantry', quantity: 2, price: 2.49 },
        { name: 'Greek Yogurt', category: 'Dairy', quantity: 4, price: 1.29 },
      ],
      total: 16.09,
    },
  ],
});

// ---------------------------------------------------------------------------
// MALFORMED DATA (for error handling tests)
// ---------------------------------------------------------------------------
export const MALFORMED_CSV = `date,amount,category
2025-01-15,-42.50,groceries
this is not a number,not valid
2025-01-17,-15.99`;

export const EMPTY_CSV = `date,amount,category`;

export const EMPTY_JSON = '[]';

export const INVALID_JSON = '{ this is not valid json }}}';

// ---------------------------------------------------------------------------
// LARGE DATASET GENERATOR (for performance + data size strategy tests)
// ---------------------------------------------------------------------------
export function generateLargeCSV(rowCount: number): string {
  const header = 'date,amount,category,description';
  const categories = ['groceries', 'rent', 'salary', 'dining', 'transport'];
  const rows: string[] = [header];

  for (let i = 0; i < rowCount; i++) {
    const date = new Date(2024, 0, 1 + (i % 365));
    const dateStr = date.toISOString().split('T')[0];
    const amount = (Math.random() * 1000 - 500).toFixed(2);
    const category = categories[i % categories.length];
    rows.push(`${dateStr},${amount},${category},Transaction ${i}`);
  }

  return rows.join('\n');
}
