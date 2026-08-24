/** Base contract every repository implements. */
export interface Repository<T> {
  findById(id: string): Promise<T | null>;
}
