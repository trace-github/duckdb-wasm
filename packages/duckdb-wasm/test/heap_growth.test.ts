import { viewHeapU8, viewHeapF64 } from '../src/bindings/runtime';
import { DuckDBModule } from '../src/bindings/duckdb_module';

/// In the threaded (COI) build, a pthread can grow the shared wasm memory at
/// any time. Emscripten only refreshes this thread's HEAPU8 view lazily from
/// glue-internal accessors, so mod.HEAPU8 may still view the old, shorter
/// SharedArrayBuffer. viewHeapU8 must detect that and force a refresh through
/// the exported stringToUTF8 runtime method (a no-op write that runs the
/// glue's staleness check) before constructing a view.
export function testHeapGrowthGuard(): void {
    describe('Heap growth guard', () => {
        // Mimics the Emscripten glue: stringToUTF8 refreshes mod.HEAPU8 to the
        // current memory size, as GROWABLE_HEAP_U8 does in the real module.
        const makeMod = (viewSize: number, memorySize: number) => {
            const mod = {
                HEAPU8: new Uint8Array(new ArrayBuffer(viewSize)),
                refreshCalls: 0,
                stringToUTF8: (_str: string, _outPtr: number, _maxBytes: number) => {
                    mod.refreshCalls += 1;
                    if (memorySize > mod.HEAPU8.buffer.byteLength) {
                        mod.HEAPU8 = new Uint8Array(new ArrayBuffer(memorySize));
                    }
                },
            };
            return mod;
        };

        it('returns a view without refreshing when the span fits', () => {
            const mod = makeMod(1024, 1024);
            const view = viewHeapU8(mod as unknown as DuckDBModule, 128, 256);
            expect(mod.refreshCalls).toBe(0);
            expect(view.buffer).toBe(mod.HEAPU8.buffer);
            expect(view.byteOffset).toBe(128);
            expect(view.length).toBe(256);
        });

        it('refreshes the view when the span exceeds a stale buffer', () => {
            const mod = makeMod(1024, 8192);
            const view = viewHeapU8(mod as unknown as DuckDBModule, 2048, 4096);
            expect(mod.refreshCalls).toBe(1);
            expect(view.buffer).toBe(mod.HEAPU8.buffer);
            expect(view.buffer.byteLength).toBe(8192);
            expect(view.byteOffset).toBe(2048);
            expect(view.length).toBe(4096);
        });

        it('throws a descriptive error if the span exceeds memory even after refresh', () => {
            const mod = makeMod(1024, 1024);
            expect(() => viewHeapU8(mod as unknown as DuckDBModule, 512, 1024)).toThrowError(/wasm memory/);
            expect(mod.refreshCalls).toBe(1);
        });

        it('returns a Float64Array view and refreshes when stale', () => {
            const mod = makeMod(1024, 8192);
            const fits = viewHeapF64(mod as unknown as DuckDBModule, 512, 3);
            expect(mod.refreshCalls).toBe(0);
            expect(fits.byteOffset).toBe(512);
            expect(fits.length).toBe(3);
            const grown = viewHeapF64(mod as unknown as DuckDBModule, 4096, 3);
            expect(mod.refreshCalls).toBe(1);
            expect(grown.buffer).toBe(mod.HEAPU8.buffer);
            expect(grown.byteOffset).toBe(4096);
            expect(grown.length).toBe(3);
            grown[0] = 42;
            expect(new Float64Array(mod.HEAPU8.buffer, 4096, 1)[0]).toBe(42);
        });
    });
}