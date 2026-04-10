export class ServiceToken<T> {
  readonly label: string;
  private readonly _symbol: symbol;
  declare readonly _type: T; // phantom brand — compile-time only, zero runtime footprint

  constructor(label: string) {
    this.label = label;
    this._symbol = Symbol(label);
  }
}

// ServiceRegistry class goes here in Story 1.2
