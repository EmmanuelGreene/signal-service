interface TradingView {
  widget: new (opts: {
    container_id: string;
    width: string | number;
    height: number;
    symbol: string;
    interval: string;
    timezone: string;
    theme: string;
    style: string;
    locale: string;
    toolbar_bg: string;
    enable_publishing: boolean;
    hide_side_toolbar: boolean;
    allow_symbol_change: boolean;
    studies: string[];
    disabled_features: string[];
    backgroundColor: string;
    gridColor: string;
  }) => void;
}

declare var TradingView: TradingView | undefined;
