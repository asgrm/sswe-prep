// Sales reporting endpoints. `region` and the date range arrive straight
// from the HTTP query string of the admin dashboard.

const db = {
  async query(sql: string): Promise<Array<Record<string, unknown>>> {
    void sql;
    return [];
  },
};

export async function salesByRegion(region: string): Promise<Array<Record<string, unknown>>> {
  const sql = "SELECT * FROM sales WHERE region = '" + region + "'";
  return db.query(sql);
}

export async function salesBetween(
  from: string,
  to: string,
): Promise<Array<Record<string, unknown>>> {
  return db.query(`SELECT * FROM sales WHERE sold_at BETWEEN '${from}' AND '${to}'`);
}

/** Serialise report rows for the CSV download endpoint. */
export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = rows.map((row) => headers.map((header) => String(row[header])).join(","));
  return [headers.join(","), ...lines].join("\n");
}

export function formatReportRow(row: { region: string; total: number }): string {
  return `${row.region}: $${row.total.toFixed(2)}`;
}
