import { ImapFlow } from 'imapflow';
import 'dotenv/config'
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

import fs from "node:fs";
import { pipeline } from "node:stream/promises";

import { google } from "googleapis";
import readline from "readline";

const REDIRECT_URI = "http://localhost";

const client = new ImapFlow({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: true,
    auth: {
        user: process.env.EMAIL_USERNAME,
        pass: process.env.EMAIL_PASSWORD
    },
    logger: false,
});

function findAttachments(node, path = []) {
    let attachments = [];

    if (node.disposition === 'attachment' ||
        (node.type && node.type !== 'text' && node.type !== 'multipart' && !node.disposition)) {
        attachments.push({
            part: path.length ? path.join('.') : '1',
            type: `${node.type}/${node.subtype || 'octet-stream'}`,
            size: node.size,
            filename: node.dispositionParameters?.filename ||
                node.parameters?.name ||
                'unnamed'
        });
    }

    if (node.childNodes) {
        node.childNodes.forEach((child, i) => {
            attachments.push(...findAttachments(child, [...path, i + 1]));
        });
    }

    return attachments;
}

async function downloadAttachment(messageUid, attachmentPart, savePath) {
    let lock = await client.getMailboxLock('INBOX');
    try {
        let { meta, content } = await client.download(
            messageUid,
            attachmentPart,
            { uid: true }
        );

        console.log(meta);
        console.log(content);
        console.log('Downloading:', meta.filename || 'attachment');
        console.log('Content-Type:', meta.contentType);
        console.log('Expected size:', meta.expectedSize, 'bytes');

        await pipeline(content, fs.createWriteStream(savePath));

        console.log(`Saved to ${savePath}`);
    } finally {
        lock.release();
    }
}

async function extractShiftsFromPdf(filename) {
    // pdfjsLib.GlobalWorkerOptions.workerSrc = browser.runtime.getURL("pdfjs/pdf.worker.mjs");
    const pdf = await pdfjsLib.getDocument(filename).promise;

    let relevantPage = null;
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        if (content.items[0].str === "Op naam" && content.items.some(i => i.str === process.env.TARGET_NAME)) {
            relevantPage = await page.getTextContent();
        }
    }

    // console.log("relevantPage:");
    // console.log(relevantPage);

    const yearRegex = /Weekplanning \(\d{2}-\d{2}-(\d{4})-\d{2}-\d{2}-(\d{4})\).pdf/;
    let matches = filename.match(yearRegex);
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
            if (item.str == process.env.TARGET_NAME) {
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

async function createCalendarEvent(shift, auth) {
    const calendar = google.calendar({ version: 'v3', auth });

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

    try {
        const response = await calendar.events.insert({
            calendarId: process.env.CALENDAR_ID,
            resource: event,
        });
        console.log('Event successfully created!');
        console.log('View Event:', response.data.htmlLink);
    } catch (error) {
        console.error('Error creating event:', error.message);
    }
}

async function googleCalendarAuthorize() {
    const oauth2Client = new google.auth.OAuth2(process.env.CLIENT_ID, process.env.CLIENT_SECRET, REDIRECT_URI);

    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/calendar'],
    });

    console.log('Authorize this app by visiting this url:', authUrl);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question('Enter the code from that page here (Note: The page won\'t load. Just copy the code from the url bar. ' +
            'Everything after "code=" up until the first "&". Replace the %2F at the start with a slash. ' +
            'The code should start with "4/"): ', async (code) => {
                rl.close();
                const { tokens } = await oauth2Client.getToken(code);
                oauth2Client.setCredentials(tokens);
                resolve(oauth2Client);
            });
    });
}

console.log("Authorizing to Google Calendar API...");
const auth = await googleCalendarAuthorize();

await client.connect();

let lock = await client.getMailboxLock('INBOX');
try {
    let lastCount = client.mailbox.exists;
    console.log(`Watching INBOX (${lastCount} messages)...`);

    client.on('exists', async (data) => {
        if (data.count > lastCount) {
            let newMessages = await client.fetchAll(
                `${lastCount + 1}:*`,
                {
                    envelope: true,
                    bodyStructure: true,
                }
            );
            for (let msg of newMessages) {
                console.log(`New email: ${msg.envelope.subject}`);
                const fromAddresses = msg.envelope.from.map(x => x.address);
                if (!(fromAddresses.some(a => a == process.env.TARGET_SENDER) || process.env.DEBUG_MODE && fromAddresses.some(a => a == process.env.DEBUG_SENDER))) {
                    console.log("Not the sender we're looking for");
                    continue;
                }
                console.log("Sender correct!");

                let attachments = findAttachments(msg.bodyStructure);
                let filteredAttachments = attachments.filter(a => a.filename !== "unnamed");
                console.log(attachments);
                console.log(filteredAttachments);

                if (filteredAttachments.length <= 0) {
                    console.log("No attachments");
                    continue;
                }

                const attachment = filteredAttachments[0];
                console.log("Attachment found: " + attachment.filename);

                await downloadAttachment(msg.uid, attachment.part, attachment.filename).catch(console.error);
                console.log("Downloaded attachment");

                const shifts = await extractShiftsFromPdf(attachment.filename);
                console.log("Shifts found:");
                console.log(shifts);
                console.log("Creating events:");
                for (let shift of shifts) {
                    await createCalendarEvent(shift, auth);
                }
            }
            lastCount = data.count;
        }
    });

    await new Promise(resolve => process.on('SIGINT', resolve));
} finally {
    lock.release();
}

await client.logout();
