import { findAttachments, downloadAttachment } from "./mailHelpers.mjs";
import { extractShiftsFromPdf } from "./parsePdf.mjs";
import * as googleCalendar from "./googleCalendar.mjs";
import { ImapFlow } from 'imapflow';
import { sleep, formatDate } from "./helpers.mjs";
import 'dotenv/config';

const config = {
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: true,
    auth: {
        user: process.env.EMAIL_USERNAME,
        pass: process.env.EMAIL_PASSWORD
    },
    logger: false,
}

console.log(formatDate(new Date()), "|", "Authorizing to Google Calendar API...");
const calendarApi = await googleCalendar.authorize();

let shuttingDown = false;
let lastKnownUid = null;
let client;
let lock;
while (!shuttingDown) {
    try {
        client = new ImapFlow(config);

        client.on("error", err => {
            console.error(formatDate(new Date()), "|", "IMAP error:", err);
            console.log(formatDate(new Date()), "|", `Continuing to watch INBOX...`);
        });

        console.log(formatDate(new Date()), "|", "Connecting to IMAP...");
        await client.connect();
        lock = await client.getMailboxLock('INBOX');

        console.log(formatDate(new Date()), "|", "IMAP connected");

        if (lastKnownUid == null) {
            lastKnownUid = (await client.fetchOne("*", { flags: true })).uid;
        } else {
            console.log(formatDate(new Date()), "|", "Just reconnected. Checking for messages that appeared while disconnected...");
            try {
                await handleNewMessages(client);
            } catch (err) {
                console.error(`Something went wrong handling a message: ${err}`);
            }
        }

        console.log(formatDate(new Date()), "|", "Watching for new messages...");
        client.on('exists', async () => {
            try {
                await handleNewMessages(client);
            } catch (err) {
                console.error(`Something went wrong handling a message: ${err}`);
            }
        });

        await new Promise(resolve => {
            client.once("close", resolve);
        });

        console.log(formatDate(new Date()), "|", "IMAP connection closed.");
        lock.release();
    } catch (err) {
        console.error(formatDate(new Date()), "|", "IMAP error:", err);
        client.close();
    }

    if (!shuttingDown) {
        console.log(formatDate(new Date()), "|", "Reconnecting in 5 seconds...");
        await sleep(5_000);
    }
}

async function handleNewMessages(client) {
    let newMessages = await client.fetchAll(
        `${lastKnownUid + 1}:*`,
        {
            envelope: true,
            bodyStructure: true,
        },
        {
            uid: true,
        }
    );
    for (let msg of newMessages) {
        if (msg.uid > lastKnownUid) lastKnownUid = msg.uid;
        console.log(formatDate(new Date()), "|", `New email: '${msg.envelope.subject}' (${msg.uid})`);
        const fromAddresses = msg.envelope.from.map(x => x.address);
        if (!(fromAddresses.some(a => a == process.env.TARGET_SENDER) || process.env.DEBUG_MODE && fromAddresses.some(a => a == process.env.DEBUG_SENDER))) {
            console.log(formatDate(new Date()), "|", "Not the sender we're looking for");
            continue;
        }
        console.log(formatDate(new Date()), "|", "Sender correct!");

        let attachments = findAttachments(msg.bodyStructure);
        let filteredAttachments = attachments.filter(a => a.filename !== "unnamed");

        if (filteredAttachments.length <= 0) {
            console.log(formatDate(new Date()), "|", "No attachments");
            continue;
        }

        const attachment = filteredAttachments[0];
        console.log(formatDate(new Date()), "|", "Attachment found: " + attachment.filename);

        const pdfBuffer = await downloadAttachment(client, msg.uid, attachment.part).catch(console.error);
        console.log(formatDate(new Date()), "|", "Downloaded attachment");

        const shifts = await extractShiftsFromPdf(pdfBuffer, attachment.filename);
        console.log(formatDate(new Date()), "|", "Shifts found:");
        console.log("[");
        for (let shift of shifts) {
            console.log("  {");
            console.log(`    type: '${shift.type}',`);
            console.log(`    startDateTime: '${formatDate(shift.startDateTime)}',`);
            console.log(`    endDateTime: '${formatDate(shift.endDateTime)}',`);
            console.log("  },");
        }
        console.log("]");

        const weekRangeRegex = /Weekplanning \((\d{2}-\d{2}-\d{4})-(\d{2}-\d{2}-\d{4})\).pdf/;
        const matches = attachment.filename.match(weekRangeRegex);
        const startDate = new Date(matches[1].replace(/(\d{2})-(\d{2})-(\d{4})/, '$2-$1-$3'));
        const endDate = new Date(matches[2].replace(/(\d{2})-(\d{2})-(\d{4})/, '$2-$1-$3'));
        // Add one day because this is the upper bound for the range.
        // By adding 1 day we ensure the last day is included in the range.
        endDate.setDate(endDate.getDate() + 1);

        console.log(formatDate(new Date()), "|", `Clearing week from ${formatDate(startDate)} to ${formatDate(endDate)}...`);
        await googleCalendar.clearWeek(calendarApi, process.env.CALENDAR_ID, startDate, endDate);
        console.log(formatDate(new Date()), "|", "Creating events...");
        for (let shift of shifts) {
            await googleCalendar.createEvent(calendarApi, process.env.CALENDAR_ID, shift);
        }
    }
    console.log(formatDate(new Date()), "|", `Continuing to watch INBOX...`);
}
