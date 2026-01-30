export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function timeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), ms)
        )
    ]);
}
