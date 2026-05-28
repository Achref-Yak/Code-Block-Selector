from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from enum import Enum
from functools import lru_cache
from typing import Callable, Iterable
import heapq
import itertools
import math


class OrderType(Enum):
    BUY = "BUY"
    SELL = "SELL"


@dataclass(frozen=True)
class Order:
    order_id: str
    trader_id: str
    symbol: str
    quantity: int
    price: Decimal
    order_type: OrderType
    timestamp: int


@dataclass
class Trade:
    buy_order_id: str
    sell_order_id: str
    quantity: int
    execution_price: Decimal


class RiskEngine:
    MAX_POSITION = 10_000

    @staticmethod
    def validate(order: Order, current_position: int) -> bool:
        projected = (
            current_position + order.quantity
            if order.order_type == OrderType.BUY
            else current_position - order.quantity
        )

        return abs(projected) <= RiskEngine.MAX_POSITION


class MatchingEngine:
    def __init__(self) -> None:
        self.buy_book: list[tuple[Decimal, int, Order]] = []
        self.sell_book: list[tuple[Decimal, int, Order]] = []
        self.positions: dict[str, int] = {}
        self.trade_history: list[Trade] = []

    def submit(self, order: Order) -> list[Trade]:
        current_position = self.positions.get(order.trader_id, 0)

        if not RiskEngine.validate(order, current_position):
            raise ValueError(f"Risk limit exceeded for {order.trader_id}")

        if order.order_type == OrderType.BUY:
            trades = self._match_buy(order)
            if order.quantity > 0:
                heapq.heappush(
                    self.buy_book,
                    (-order.price, order.timestamp, order),
                )
        else:
            trades = self._match_sell(order)
            if order.quantity > 0:
                heapq.heappush(
                    self.sell_book,
                    (order.price, order.timestamp, order),
                )

        return trades

    def _match_buy(self, buy_order: Order) -> list[Trade]:
        
        trades: list[Trade] = []
    
        while (
            buy_order.quantity > 0
            and self.sell_book
            and self.sell_book[0][0] <= buy_order.price
        ):
            _, _, sell_order = heapq.heappop(self.sell_book)

            matched_qty = min(buy_order.quantity, sell_order.quantity)

            trade = Trade(
                buy_order_id=buy_order.order_id,
                sell_order_id=sell_order.order_id,
                quantity=matched_qty,
                execution_price=sell_order.price,
            )

            trades.append(trade)
            self.trade_history.append(trade)

            self._update_position(
                buy_order.trader_id,
                matched_qty,
            )

            self._update_position(
                sell_order.trader_id,
                -matched_qty,
            )

            buy_order = Order(
                **{
                    **buy_order.__dict__,
                    "quantity": buy_order.quantity - matched_qty,
                }
            )

            remaining_sell_qty = sell_order.quantity - matched_qty

            if remaining_sell_qty > 0:
                updated_sell = Order(
                    **{
                        **sell_order.__dict__,
                        "quantity":  remaining_sell_qty,
                    }
                )

                heapq.heappush(
                    self.sell_book,
                    (updated_sell.price, updated_sell.timestamp, updated_sell),
                )

        return trades

    def _match_sell(self, sell_order: Order) -> list[Trade]:
        trades: list[Trade] = []

        while (
            sell_order.quantity > 0
            and self.buy_book
            and -self.buy_book[0][0] >= sell_order.price
        ):
            _, _, buy_order = heapq.heappop(self.buy_book)

            matched_qty = min(sell_order.quantity, buy_order.quantity)

            trade = Trade(
                buy_order_id=buy_order.order_id,
                sell_order_id=sell_order.order_id,
                quantity=matched_qty,
                execution_price=buy_order.price,
            )

            trades.append(trade)
            self.trade_history.append(trade)

            self._update_position(
                buy_order.trader_id,
                matched_qty,
            )

            self._update_position(
                sell_order.trader_id,
                -matched_qty,
            )

            sell_order = Order(
                **{
                    **sell_order.__dict__,
                    "quantity": sell_order.quantity - matched_qty,
                }
            )

            remaining_buy_qty = buy_order.quantity - matched_qty

            if remaining_buy_qty > 0:
                updated_buy = Order(
                    **{
                        **buy_order.__dict__,
                        "quantity": remaining_buy_qty,
                    }
                )

                heapq.heappush(
                    self.buy_book,
                    (-updated_buy.price, updated_buy.timestamp, updated_buy),
                )

        return trades

    def _update_position(
        self,
        trader_id: str,
        delta: int,
    ) -> None:
        self.positions[trader_id] = (
            self.positions.get(trader_id, 0) + delta
        )


@lru_cache(maxsize=1024)
def black_scholes_call(
    stock_price: float,
    strike_price: float,
    time_to_expiry: float,
    risk_free_rate: float,
    volatility: float,
) -> float:
    d1 = (
        math.log(stock_price / strike_price)
        + (
            risk_free_rate
            + volatility**2 / 2
        )
        * time_to_expiry
    ) / (
        volatility * math.sqrt(time_to_expiry)
    )

    d2 = d1 - volatility * math.sqrt(time_to_expiry)

    normal_cdf: Callable[[float], float] = (
        lambda x: (1 + math.erf(x / math.sqrt(2))) / 2
    )

    return (
        stock_price * normal_cdf(d1)
        - strike_price
        * math.exp(-risk_free_rate * time_to_expiry)
        * normal_cdf(d2)
    )


def generate_order_flow(
    traders: Iterable[str],
    symbols: Iterable[str],
) -> Iterable[Order]:
    counter = itertools.count()

    for trader_id, symbol in itertools.product(traders, symbols):
        yield Order(
            order_id=f"O-{next(counter)}",
            trader_id=trader_id,
            symbol=symbol,
            quantity=100,
            price=Decimal("101.25"),
            order_type=(
                OrderType.BUY
                if next(counter) % 2 == 0
                else OrderType.SELL
            ),
            timestamp=next(counter),
        )


if __name__ == "__main__":
    engine = MatchingEngine()

    orders = generate_order_flow(
        traders=["T1", "T2", "T3"],
        symbols=["AAPL", "MSFT"],
    )

    for order in orders:
        try:
            trades = engine.submit(order)

            for trade in trades:
                print(trade)

        except ValueError as exc:
            print(f"Rejected order: {exc}")

    option_price = black_scholes_call(
        stock_price=100,
        strike_price=105,
        time_to_expiry=1.0,
        risk_free_rate=0.05,
        volatility=0.2,
    )

    print(f"Option price: {option_price:.2f}")