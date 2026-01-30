export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export const dateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false
});

export function formatDate(date) {
    return dateFormatter.format(date).replaceAll(", ", " ");
}
