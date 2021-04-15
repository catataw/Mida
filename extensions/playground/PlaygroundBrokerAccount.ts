import { MidaBrokerAccount } from "#brokers/MidaBrokerAccount";
import { MidaBrokerAccountType } from "#brokers/MidaBrokerAccountType";
import { MidaBrokerOrder } from "#orders/MidaBrokerOrder";
import { MidaSymbolTick } from "#ticks/MidaSymbolTick";
import { MidaBrokerOrderStatusType } from "#orders/MidaBrokerOrderStatusType";
import { MidaBrokerOrderDirectives } from "#orders/MidaBrokerOrderDirectives";
import { MidaBrokerOrderType } from "#orders/MidaBrokerOrderType";
import { MidaSymbolPeriod } from "#periods/MidaSymbolPeriod";
import { MidaSymbolQuotationPriceType } from "#quotations/MidaSymbolQuotationPriceType";
import { MidaSymbol } from "#symbols/MidaSymbol";

import { PlaygroundBrokerAccountParameters } from "#../extensions/playground/PlaygroundBrokerAccountParameters";

export class PlaygroundBrokerAccount extends MidaBrokerAccount {
    private _localDate: Date;
    private _balance: number;
    private _ticketsCounter: number;
    private readonly _orders: Map<number, MidaBrokerOrder>;
    private _negativeBalanceProtection: boolean;
    private _fixedOrderCommission: number;
    private _marginCallLevel: number;
    private _stopOutLevel: number;
    private readonly _localTicks: {
        [symbol: string]: MidaSymbolTick[];
    };
    private readonly _lastTicks: {
        [symbol: string]: MidaSymbolTick;
    };

    public constructor ({
        id,
        ownerName,
        broker,
        localDate,
        currency,
        balance,
        negativeBalanceProtection = false,
        fixedOrderCommission = 0,
        marginCallLevel = 100,
        stopOutLevel = 50,
    }: PlaygroundBrokerAccountParameters) {
        super({ id, ownerName, type: MidaBrokerAccountType.DEMO, currency, broker, });

        this._localDate = new Date(localDate);
        this._localTicks = {};
        this._lastTicks = {};
        this._balance = balance;
        this._ticketsCounter = 0;
        this._orders = new Map();
        this._negativeBalanceProtection = negativeBalanceProtection;
        this._fixedOrderCommission = fixedOrderCommission;
        this._marginCallLevel = marginCallLevel;
        this._stopOutLevel = stopOutLevel;
    }

    public get localDate (): Date {
        return new Date(this._localDate);
    }

    public set localDate (value: Date) {
        this._localDate = new Date(value);
    }

    public get negativeBalanceProtection (): boolean {
        return this._negativeBalanceProtection;
    }

    public set negativeBalanceProtection (value: boolean) {
        this._negativeBalanceProtection = value;
    }

    public get fixedOrderCommission (): number {
        return this._fixedOrderCommission;
    }

    public set fixedOrderCommission (value: number) {
        this._fixedOrderCommission = Math.abs(value || 0);
    }

    public get marginCallLevel (): number {
        return this._marginCallLevel;
    }

    public set marginCallLevel (value: number) {
        this._marginCallLevel = value;
    }

    public get stopOutLevel (): number {
        return this._stopOutLevel;
    }

    public set stopOutLevel (value: number) {
        this._stopOutLevel = value;
    }

    public async getBalance (): Promise<number> {
        return this._balance;
    }

    public async getEquity (): Promise<number> {
        const orders: MidaBrokerOrder[] = await this.getOpenOrders();
        const profits: number[] = await Promise.all(orders.map((order: MidaBrokerOrder): Promise<number> => order.getNetProfit()));

        return this._balance + profits.reduce((a: number, b: number) => a + b, 0);
    }

    public async getUsedMargin (): Promise<number> {
        // throw new Error();
        return 0;
    }

    public async getOrders (): Promise<MidaBrokerOrder[]> {
        return [ ...this._orders.values(), ];
    }

    public async getOrder (ticket: number): Promise<MidaBrokerOrder | undefined> {
        return this._orders.get(ticket);
    }

    public async getOrderGrossProfit (ticket: number): Promise<number> {
        const order: MidaBrokerOrder | undefined = this._orders.get(ticket);

        if (!order) {
            throw new Error();
        }

        const openPrice: number | undefined = order.openPrice;

        if (openPrice === undefined) {
            throw new Error();
        }

        let closePrice: number | undefined;

        if (order.status === MidaBrokerOrderStatusType.OPEN) {
            const lastTick: MidaSymbolTick = await this.getSymbolLastTick(order.symbol);

            if (order.type === MidaBrokerOrderType.SELL) {
                closePrice = lastTick.ask;
            }
            else if (order.type === MidaBrokerOrderType.BUY) {
                closePrice = lastTick.bid;
            }
            else {
                throw new Error();
            }
        }
        else if (order.status === MidaBrokerOrderStatusType.CLOSED) {
            closePrice = order.closePrice;
        }
        else {
            throw new Error();
        }

        if (closePrice === undefined) {
            throw new Error();
        }

        if (order.type === MidaBrokerOrderType.SELL) {
            return (openPrice - closePrice) * order.lots * 100000;
        }
        else if (order.type === MidaBrokerOrderType.BUY) {
            return (closePrice - openPrice) * order.lots * 100000;
        }

        throw new Error();
    }

    public async getOrderNetProfit (ticket: number): Promise<number> {
        const tasks: Promise<number>[] = [ this.getOrderGrossProfit(ticket), this.getOrderSwaps(ticket), this.getOrderCommission(ticket), ];
        const [ grossProfit, swaps, commission, ]: number[] = await Promise.all(tasks);

        return grossProfit + swaps - Math.abs(commission);
    }

    public async getOrderSwaps (ticket: number): Promise<number> {
        return 0;
    }

    public async getOrderCommission (ticket: number): Promise<number> {
        return this._fixedOrderCommission;
    }

    public async placeOrder (directives: MidaBrokerOrderDirectives): Promise<MidaBrokerOrder> {
        const symbol: string = directives.symbol;
        const lastTick: MidaSymbolTick = await this.getSymbolLastTick(symbol);
        const isBuyOrder: boolean = directives.type === MidaBrokerOrderType.BUY;
        const isMarketOrder: boolean = !Number.isFinite(directives.stop) && !Number.isFinite(directives.limit);

        const order: MidaBrokerOrder = new MidaBrokerOrder({
            ticket: ++this._ticketsCounter,
            brokerAccount: this,
            requestDirectives: directives,
            requestDate: this._localDate,
            creationDate: this._localDate,
            openDate: isMarketOrder ? this._localDate : undefined,
            creationPrice: isBuyOrder ? lastTick.ask : lastTick.bid,
            openPrice: isMarketOrder ? (isBuyOrder ? lastTick.ask : lastTick.bid) : undefined,
        });

        this._orders.set(order.ticket, order);

        return order;
    }

    public async cancelOrder (ticket: number): Promise<void> {
        const order: MidaBrokerOrder | undefined = this._orders.get(ticket);

        if (!order) {
            throw new Error();
        }

        if (order.status !== MidaBrokerOrderStatusType.PENDING) {
            throw new Error();
        }

        const lastTick: MidaSymbolTick = await this.getSymbolLastTick(order.symbol);
        let cancelPrice: number | undefined;

        if (order.type === MidaBrokerOrderType.SELL) {
            cancelPrice = lastTick.ask;
        }
        else if (order.type === MidaBrokerOrderType.BUY) {
            cancelPrice = lastTick.bid;
        }
        else {
            throw new Error();
        }

        if (cancelPrice === undefined) {
            throw new Error();
        }

        this.notifyListeners("order-cancel", {
            ticket: order.ticket,
            date: new Date(this._localDate),
            price: cancelPrice,
        });
    }

    public async closeOrder (ticket: number): Promise<void> {
        const order: MidaBrokerOrder | undefined = this._orders.get(ticket);

        if (!order) {
            throw new Error();
        }

        if (order.status !== MidaBrokerOrderStatusType.OPEN) {
            throw new Error();
        }

        const lastTick: MidaSymbolTick = await this.getSymbolLastTick(order.symbol);
        let closePrice: number | undefined;

        if (order.type === MidaBrokerOrderType.SELL) {
            closePrice = lastTick.ask;
        }
        else if (order.type === MidaBrokerOrderType.BUY) {
            closePrice = lastTick.bid;
        }
        else {
            throw new Error();
        }

        if (closePrice === undefined) {
            throw new Error();
        }

        this._balance += await order.getNetProfit();

        this.notifyListeners("order-close", {
            ticket: order.ticket,
            date: new Date(this._localDate),
            price: closePrice,
        });
    }

    public async getSymbols (): Promise<MidaSymbol[]> {
        return [];
    }

    public async getSymbol (symbol: string): Promise<MidaSymbol> {
        throw new Error();
    }

    public async isSymbolMarketOpen (symbol: string): Promise<boolean> {
        throw new Error();
    }

    public async getSymbolPeriods (symbol: string, timeframe: number, priceType?: MidaSymbolQuotationPriceType): Promise<MidaSymbolPeriod[]> {
        return [];
    }

    public async getSymbolLastTick (symbol: string): Promise<MidaSymbolTick> {
        const lastTick: MidaSymbolTick = this._lastTicks[symbol];

        if (!lastTick) {
            throw new Error();
        }

        return lastTick;
    }

    /**
     * Used to elapse a given amount of time.
     * @param amount Amount of time to elapse in seconds.
     */
    public async elapseTime (amount: number): Promise<MidaSymbolTick[]> {
        const previousDate: Date = this._localDate;
        const actualDate: Date = new Date(this._localDate.valueOf() + amount * 1000);
        const elapsedTicks: MidaSymbolTick[] = [];

        for (const symbol in this._localTicks) {
            const ticks: MidaSymbolTick[] = this._localTicks[symbol];

            for (const tick of ticks) {
                if (tick.date > previousDate && tick.date <= actualDate) {
                    elapsedTicks.push(tick);
                }
            }
        }

        elapsedTicks.sort((a: MidaSymbolTick, b: MidaSymbolTick): number => a.date.valueOf() - b.date.valueOf());

        for (const tick of elapsedTicks) {
            this._localDate = new Date(tick.date);

            this._lastTicks[tick.symbol] = tick;

            await this._onTick(tick);
        }

        this._localDate = actualDate;

        return elapsedTicks;
    }

    public deposit (amount: number): void {
        this._balance += amount;
    }

    public withdraw (amount: number): void {
        this._balance -= amount;
    }

    public async loadTicks (ticks: MidaSymbolTick[]): Promise<void> {
        if (ticks.length < 1) {
            throw new Error();
        }

        const symbol: string = ticks[0].symbol;
        const localTicks: MidaSymbolTick[] = this._localTicks[symbol] || [];
        const updatedTicks: MidaSymbolTick[] = localTicks.concat(ticks);

        updatedTicks.sort((a: MidaSymbolTick, b: MidaSymbolTick): number => a.date.valueOf() - b.date.valueOf());

        this._localTicks[symbol] = updatedTicks;
    }

    public getSymbolTicks (symbol: string): MidaSymbolTick[] {
        return this._localTicks[symbol] || [];
    }

    private async _openPendingOrder (ticket: number): Promise<void> {
        const order: MidaBrokerOrder | undefined = this._orders.get(ticket);

        if (!order) {
            throw new Error();
        }

        if (order.status !== MidaBrokerOrderStatusType.PENDING) {
            throw new Error();
        }

        const lastTick: MidaSymbolTick = await this.getSymbolLastTick(order.symbol);
        let openPrice: number | undefined;

        if (order.type === MidaBrokerOrderType.SELL) {
            openPrice = lastTick.bid;
        }
        else if (order.type === MidaBrokerOrderType.BUY) {
            openPrice = lastTick.ask;
        }
        else {
            throw new Error();
        }

        if (openPrice === undefined) {
            throw new Error();
        }

        this.notifyListeners("order-open", {
            ticket: order.ticket,
            date: new Date(this._localDate),
            price: openPrice,
        });
    }

    private async _onTick (tick: MidaSymbolTick): Promise<void> {
        const tasks: Promise<void>[] = [ this._updatePendingOrders(tick), this._updateOpenOrders(tick), ];

        await Promise.all(tasks);

        this.notifyListeners("tick", { tick, });

        // <margin-call>
        const marginLevel: number = await this.getMarginLevel();

        if (Number.isFinite(marginLevel) && marginLevel <= this._marginCallLevel) {
            this.notifyListeners("margin-call", {
                marginLevel,
            });
        }
        // </margin-call>
    }

    // tslint:disable-next-line:cyclomatic-complexity
    private async _updatePendingOrders (tick: MidaSymbolTick): Promise<void> {
        const orders: MidaBrokerOrder[] = await this.getPendingOrders();

        for (const order of orders) {
            // <limit>
            if (order.limit !== undefined) {
                if (
                    (order.type === MidaBrokerOrderType.SELL && tick.bid >= order.limit)
                    || (order.type === MidaBrokerOrderType.BUY && tick.ask <= order.limit)
                ) {
                    await this._openPendingOrder(order.ticket);
                }
            }
            // </limit>

            // <stop>
            if (order.stop !== undefined) {
                if (
                    (order.type === MidaBrokerOrderType.SELL && tick.bid <= order.stop)
                    || (order.type === MidaBrokerOrderType.BUY && tick.ask >= order.stop)
                ) {
                    await this._openPendingOrder(order.ticket);
                }
            }
            // </stop>
        }
    }

    // tslint:disable-next-line:cyclomatic-complexity
    private async _updateOpenOrders (tick: MidaSymbolTick): Promise<void> {
        const orders: MidaBrokerOrder[] = await this.getOpenOrders();

        for (const order of orders) {
            // <stop-loss>
            if (order.stopLoss !== undefined) {
                if (
                    (order.type === MidaBrokerOrderType.SELL && tick.ask >= order.stopLoss)
                    || (order.type === MidaBrokerOrderType.BUY && tick.bid <= order.stopLoss)
                ) {
                    await order.close();
                }
            }
            // </stop-loss>

            // <take-profit>
            if (order.takeProfit !== undefined) {
                if (
                    (order.type === MidaBrokerOrderType.SELL && tick.ask <= order.takeProfit)
                    || (order.type === MidaBrokerOrderType.BUY && tick.bid >= order.takeProfit)
                ) {
                    await order.close();
                }
            }
            // </take-profit>

            // <stop-out>
            const marginLevel: number = await this.getMarginLevel();

            if (Number.isFinite(marginLevel) && marginLevel <= this._stopOutLevel) {
                await order.close();

                this.notifyListeners("stop-out", {
                    ticket: order.ticket,
                    marginLevel,
                });
            }
            // </stop-out>

            // <negative-balance-protection>
            const equity: number = await this.getEquity();

            if (this._negativeBalanceProtection && equity < 0) {
                await order.close();
            }
            // </negative-balance-protection>
        }
    }
}