import * as pdfjsLib from "./pdfjs/pdf.mjs";
import { env } from "./config.js";

const REDIRECT_URI = browser.identity.getRedirectURL();

console.log("Authorizing to Google Calendar API...");
await googleCalendarAuthorize();

messenger.messages.onNewMailReceived.addListener(async (folder, messages) => {
    console.log("New message!");
    for (const message of messages.messages) {
        try {
            if (!(message.author?.includes(env["TARGET_SENDER"]) || env["DEBUG_MODE"] && message.author?.includes(env["DEBUG_SENDER"]))) {
                continue;
            }
            console.log("Author correct!");

            const attachments = await browser.messages.listAttachments(message.id);
            if (!attachments.length) {
                continue;
            }
            console.log("Attachment found!");

            const attachment = attachments[0];
            const file = await browser.messages.getAttachmentFile(
                message.id,
                attachment.partName
            );
            console.log("Attachment info:");
            console.log(file);

            const shifts = await extractShiftsFromPdf(file);
            console.log("Shifts found:");
            console.log(shifts);

            console.log("Adding shifts to calendar...");
            for (const shift of shifts) {
                await createCalendarEvent(shift);
            }
        } catch (err) {
            console.error("Failed to process message", err);
        }
    }
});

async function extractShiftsFromPdf(file) {
    const arrayBuffer = await file.arrayBuffer();
    pdfjsLib.GlobalWorkerOptions.workerSrc = browser.runtime.getURL("pdfjs/pdf.worker.mjs");
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    let relevantPage = null;
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        if (content.items[0].str === "Op naam" && content.items.some(i => i.str == env["TARGET_NAME"])) {
            relevantPage = await page.getTextContent();
        }
    }

    // console.log("relevantPage:");
    // console.log(relevantPage);

    const yearRegex = /Weekplanning \(\d{2}-\d{2}-(\d{4})-\d{2}-\d{2}-(\d{4})\).pdf/;
    let matches = file.name.match(yearRegex);
    const startYear = parseInt(matches[1]);
    const endYear = parseInt(matches[2]);

    const dateRegex = /\w\w \((\d\d) - (\d\d)\)/;
    const timeRegex = /(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/;

    const dates = new Map();
    for (let item of relevantPage.items) {
        if ((matches = item.str.match(dateRegex)) !== null) {
            const day = parseInt(matches[1]);
            const month = parseInt(matches[2]);
            const year = (startYear !== endYear && parseInt(matches[2]) == 1) ? endYear : startYear;
            dates.set(item.transform[4], new Date(year + '-' + month + '-' + day));
        }
    }
    // console.log("dates:");
    // console.log(dates);

    const shifts = [];

    let rowStartX = null;
    for (let i = 0; i < relevantPage.items.length; i++) {
        const item = relevantPage.items[i];
        if (rowStartX === null) {
            if (item.str == env["TARGET_NAME"]) {
                rowStartX = item.transform[4];
                // console.log("Found x at start of row:");
                // console.log(rowStartX);
            }
            continue;
        }

        if (item.transform[4] <= rowStartX) break;

        if ((matches = item.str.match(timeRegex)) !== null) {
            const date = dates.get(item.transform[4]);
            const startDateTime = new Date(date.getTime());
            startDateTime.setHours(matches[1]);
            startDateTime.setMinutes(matches[2]);
            const endDateTime = new Date(date.getTime());
            endDateTime.setHours(matches[3]);
            endDateTime.setMinutes(matches[4]);
            shifts.push({
                type: relevantPage.items[i - 2].str,
                startDateTime: startDateTime,
                endDateTime: endDateTime,
            });
        }
    }

    // console.log(shifts);
    return shifts;
}

async function createCalendarEvent(shift) {
    const accessToken = await getGoogleAccessToken();

    const event = {
        summary: `Kwalitaria - ${shift.type}`,
        start: {
            dateTime: shift.startDateTime,
            timeZone: "Europe/Amsterdam",
        },
        end: {
            dateTime: shift.endDateTime,
            timeZone: "Europe/Amsterdam",
        },
    };

    console.log("Sending request to url:");
    console.log(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env["CALENDAR_ID"])}/events`);
    console.log("With body");
    console.log(JSON.stringify(event));
    const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env["CALENDAR_ID"])}/events`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(event),
        }
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Google Calendar error: ${text}`);
    }
}

async function googleCalendarAuthorize() {
    console.log("redirect_uri:");
    console.log(REDIRECT_URI);
    const SCOPE = "https://www.googleapis.com/auth/calendar";

    const authUrl =
        "https://accounts.google.com/o/oauth2/v2/auth" +
        "?response_type=code" +
        `&client_id=${encodeURIComponent(env["CLIENT_ID"])}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&scope=${encodeURIComponent(SCOPE)}` +
        "&access_type=offline" +
        "&prompt=consent";

    const redirectUrl = await browser.identity.launchWebAuthFlow({
        url: authUrl,
        interactive: true,
    });

    const url = new URL(redirectUrl);
    const code = url.searchParams.get("code");

    await exchangeCodeForTokens(code);
}

async function exchangeCodeForTokens(code) {
    const body = new URLSearchParams({
        code,
        client_id: env["CLIENT_ID"],
        client_secret: env["CLIENT_SECRET"],
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
    });

    const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });

    const data = await res.json();

    await browser.storage.local.set({
        refreshToken: data.refresh_token,
        accessToken: data.access_token,
        accessTokenExpiry: Date.now() + data.expires_in * 1000,
    });
}

async function getGoogleAccessToken() {
    const stored = await browser.storage.local.get([
        "accessToken",
        "accessTokenExpiry",
        "refreshToken",
    ]);

    if (
        stored.accessToken &&
        stored.accessTokenExpiry &&
        Date.now() < stored.accessTokenExpiry - 60_000
    ) {
        return stored.accessToken;
    }

    const body = new URLSearchParams({
        client_id: env["CLIENT_ID"],
        client_secret: env["CLIENT_SECRET"],
        refresh_token: stored.refreshToken,
        grant_type: "refresh_token",
    });

    const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });

    const data = await res.json();

    await browser.storage.local.set({
        accessToken: data.access_token,
        accessTokenExpiry: Date.now() + data.expires_in * 1000,
    });

    return data.access_token;
}
