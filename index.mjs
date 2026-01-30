import { findAttachments, downloadAttachment } from "./mailHelpers.mjs";
import { extractShiftsFromPdf } from "./parsePdf.mjs";
import { googleCalendarAuthorize, createCalendarEvent } from "./googleCalendar.mjs";
import { ImapFlow } from 'imapflow';
import { sleep } from "./helpers.mjs";
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

console.log(new Date().toISOString(), "Authorizing to Google Calendar API...");
const auth = await googleCalendarAuthorize();

let shuttingDown = false;
let lastKnownModseq = null;
let client;
let lock;
while (!shuttingDown) {
    try {
        client = new ImapFlow(config);

        client.on("error", err => {
            console.error(new Date().toISOString(), "IMAP error:", err);
            console.log(new Date().toISOString(), `Continuing to watch INBOX...`);
        });

        console.log(new Date().toISOString(), "Connecting to IMAP...");
        await client.connect();
        lock = await client.getMailboxLock('INBOX');

        console.log(new Date().toISOString(), "IMAP connected");

        if (lastKnownModseq == null) {
            lastKnownModseq = (await client.fetchOne("*", { flags: true })).modseq;
        } else {
            console.log(new Date().toISOString(), "Just reconnected. Checking for messages that appeared while disconnected...");
            try {
                await handleNewMessages(client);
            } catch (err) {
                console.error(`Something went wrong handling a message: ${err}`);
            }
        }

        console.log(new Date().toISOString(), "Watching for new messages...");
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

        console.log(new Date().toISOString(), "IMAP connection closed.");
        lock.release();
    } catch (err) {
        console.error(new Date().toISOString(), "IMAP error:", err);
        client.close();
    }

    if (!shuttingDown) {
        console.log(new Date().toISOString(), "Reconnecting in 5 seconds...");
        await sleep(5_000);
    }
}

async function handleNewMessages(client) {
    let newMessages = await client.fetchAll(
        `1:*`,
        {
            envelope: true,
            bodyStructure: true,
        },
        {
            changedSince: lastKnownModseq,
        }
    );
    for (let msg of newMessages) {
        if (msg.modseq > lastKnownModseq) lastKnownModseq = msg.modseq;
        console.log(new Date().toISOString(), `New email: '${msg.envelope.subject}'`);
        const fromAddresses = msg.envelope.from.map(x => x.address);
        if (!(fromAddresses.some(a => a == process.env.TARGET_SENDER) || process.env.DEBUG_MODE && fromAddresses.some(a => a == process.env.DEBUG_SENDER))) {
            console.log(new Date().toISOString(), "Not the sender we're looking for");
            continue;
        }
        console.log(new Date().toISOString(), "Sender correct!");

        let attachments = findAttachments(msg.bodyStructure);
        let filteredAttachments = attachments.filter(a => a.filename !== "unnamed");

        if (filteredAttachments.length <= 0) {
            console.log(new Date().toISOString(), "No attachments");
            continue;
        }

        const attachment = filteredAttachments[0];
        console.log(new Date().toISOString(), "Attachment found: " + attachment.filename);

        const pdfBuffer = await downloadAttachment(client, msg.uid, attachment.part).catch(console.error);
        console.log(new Date().toISOString(), "Downloaded attachment");

        const shifts = await extractShiftsFromPdf(pdfBuffer, attachment.filename);
        console.log(new Date().toISOString(), "Shifts found:");
        console.log(shifts);
        console.log(new Date().toISOString(), "Creating events:");
        for (let shift of shifts) {
            await createCalendarEvent(shift, auth);
        }
    }
    console.log(new Date().toISOString(), `Continuing to watch INBOX...`);
}
