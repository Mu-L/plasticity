import { GeometryFactory } from '../Factory'
import c3d from '../../../build/Release/c3d.node';
import * as visual from '../../VisualModel';
import { GeometryDatabase, TemporaryObject } from '../../GeometryDatabase';
import MaterialDatabase from '../../MaterialDatabase';
import { EditorSignals } from '../../Editor';

export interface FilletParams {
    item: visual.Solid;
    edges: visual.CurveEdge[];
    distance1: number;
    distance2: number;
    begLength: number;
    endLength: number;
    equable: boolean;
    form: c3d.SmoothForm;
    conic: number;
    prolong: boolean;
    smoothCorner: c3d.CornerForm;
    keepCant: c3d.ThreeStates;
    strict: boolean;
}

export default class FilletFactory extends GeometryFactory implements FilletParams {
    private _item!: visual.Solid;
    private _edges!: visual.CurveEdge[];

    private solid!: c3d.Solid;
    curves!: c3d.EdgeFunction[];
    functions!: Map<string, c3d.CubicFunction>;
    private temp?: TemporaryObject;

    constructor(db: GeometryDatabase, materials: MaterialDatabase, signals: EditorSignals) {
        super(db, materials, signals);

        const params = new c3d.SmoothValues();
        params.distance1 = 0;
        params.distance2 = 0;
        params.form = c3d.SmoothForm.Fillet;
        params.conic = 0;
        params.prolong = false;
        params.smoothCorner = 2;
        params.keepCant = -1;
        params.strict = true;
        this.params = params;
    }

    params: c3d.SmoothValues;

    get item(): visual.Solid {
        return this._item;
    }

    set item(item: visual.Solid) {
        this._item = item;
        this.solid = this.db.lookup(this.item);
    }

    get edges(): visual.CurveEdge[] {
        return this._edges;
    }

    // FIXME the naming edges/curves is confusing
    set edges(edges: visual.CurveEdge[]) {
        this._edges = edges;

        const curves = [];
        const functions = new Map<string, c3d.CubicFunction>();
        for (const edge of edges) {
            const model = this.db.lookupTopologyItem(edge) as c3d.CurveEdge;
            const fn = new c3d.CubicFunction(1, 1);
            functions.set(edge.simpleName, fn);
            curves.push(new c3d.EdgeFunction(model, fn));
        }
        this.curves = curves;
        this.functions = functions;
    }

    get distance() { return this.params.distance1 }
    set distance(d: number) {
        const { params } = this;
        params.distance1 = d;
        params.distance2 = d;
    }

    get distance1() { return this.params.distance1 }
    set distance1(d: number) { this.params.distance1 = d }
    get distance2() { return this.params.distance2 }
    set distance2(d: number) { this.params.distance2 = d }
    get form() { return this.params.form }
    set form(d: number) { this.params.form = d }
    get conic() { return this.params.conic }
    set conic(d: number) { this.params.conic = d }
    get prolong() { return this.params.prolong }
    set prolong(d: boolean) { this.params.prolong = d }
    get smoothCorner() { return this.params.smoothCorner }
    set smoothCorner(d: c3d.CornerForm) { this.params.smoothCorner = d }
    get keepCant() { return this.params.keepCant }
    set keepCant(d: c3d.ThreeStates) { this.params.keepCant = d }
    get strict() { return this.params.strict }
    set strict(d: boolean) { this.params.strict = d }
    get begLength() { return this.params.begLength }
    set begLength(d: number) { this.params.begLength = d }
    get endLength() { return this.params.endLength }
    set endLength(d: number) { this.params.endLength = d }
    get equable() { return this.params.equable }
    set equable(d: boolean) { this.params.equable = d }

    private readonly names = new c3d.SNameMaker(c3d.CreatorType.FilletSolid, c3d.ESides.SideNone, 0);

    async doUpdate() {
        const result = await c3d.ActionSolid.FilletSolid_async(this.solid, c3d.CopyMode.Copy, this.curves, [], this.params, this.names);
        const temp = await this.db.addTemporaryItem(result);
        this.db.hide(this.item)
        this.temp?.cancel();
        this.temp = temp;
    }

    async doCommit() {
        const filletted = c3d.ActionSolid.FilletSolid(this.solid, c3d.CopyMode.Copy, this.curves, [], this.params, this.names);
        const result = await this.db.addItem(filletted);
        this.db.removeItem(this.item);
        this.temp?.cancel();
        return result;
    }

    doCancel() {
        this.db.unhide(this.item)
        this.temp?.cancel();
    }

    async check(d: number) {
        const params = new c3d.SmoothValues();
        params.distance1 = d;
        params.distance2 = d;
        params.form = 0;
        params.conic = 0;
        params.prolong = false;
        params.smoothCorner = 2;
        params.keepCant = -1;
        params.strict = true;

        await c3d.ActionSolid.FilletSolid_async(this.solid, c3d.CopyMode.Copy, this.curves, [], params, this.names);
    }
}

/**
 * The following class "clamps" fillets to a max
 */
type State = { tag: 'start' } | { tag: 'finding' } | { tag: 'found', value: number } | { tag: 'computed', value: number }

export class Max {
    private state: State = { tag: 'start' }

    constructor(
        private readonly factory: FilletFactory
    ) { }

    async start() {
        switch (this.state.tag) {
            case 'start':
                this.state = { tag: 'finding' }
                console.time("searching");
                const result = await Max.search(0.01, 0.1, 100, (d) => this.factory.check(d));
                console.timeEnd("searching");
                this.state = { tag: 'found', value: result }
                break;
            default: throw new Error("invalid state");
        }
    }

    async exec(delta: number) {
        const factory = this.factory;
        switch (this.state.tag) {
            case 'start':
            case 'finding':
                factory.distance = delta;
                await factory.transaction('distance', async () => {
                    await factory.update();
                });
                break;
            case 'found':
                const max = this.state.value;
                if (delta >= max) {
                    factory.distance = max;
                    await factory.transaction('distance', async () => {
                        await factory.update();
                        this.state = { tag: 'computed', value: max }
                    });
                } else {
                    factory.distance = delta;
                    await factory.transaction('distance', async () => {
                        await factory.update();
                    });
                }
                break;
            case 'computed':
                if (delta >= this.state.value) {
                    console.warn("skipping work because delta exceeds max");
                } else {
                    this.state = { tag: 'found', value: this.state.value }
                    await this.exec(delta);
                }
                break;
        }
    }

    static async search<_>(lastGood: number, candidate: number, max: number, cb: (n: number) => Promise<_>): Promise<number> {
        if (max < candidate) throw new Error('invalid');
        if (candidate < lastGood) throw new Error('invalid');
        if (Math.abs(candidate - lastGood) < 0.01) return Promise.resolve(lastGood);

        try {
            await cb(candidate);
            return this.search(candidate, candidate + (max - candidate) / 2, max, cb);
        } catch (e) {
            return this.search(lastGood, lastGood + (candidate - lastGood) / 2, candidate, cb);
        }
    }
}