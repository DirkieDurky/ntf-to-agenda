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
    socketTimeout: 35000,
}

console.log("Authorizing to Google Calendar API...");
const auth = await googleCalendarAuthorize();

let shuttingDown = false;
let lastCount = null;
let client;
let lock;
while (!shuttingDown) {
    try {
        client = new ImapFlow(config);

        client.on("error", err => {
            console.error(new Date().toISOString(), "IMAP error:", err);
        });

        console.log(new Date().toISOString(), "Connecting to IMAP...");
        await client.connect();
        lock = await client.getMailboxLock('INBOX');

        console.log(new Date().toISOString(), "IMAP connected");

        if (lastCount == null) {
            lastCount = client.mailbox.exists;
        } else {
            // Check for any missed mails since last connection
            console.log("Just reconnected. Checking for messages that appeared while disconnected...");
            console.log(`Last known amount of messages in INBOX: ${lastCount}`);
            console.log(`Current amount of messages in INBOX: ${client.mailbox.exists}`);
            if (client.mailbox.exists > lastCount) {
                console.log("New message(s) found");
                try {
                    await handleNewMessages(client, lastCount);
                } catch (err) {
                    console.log(`Error while handling new messages: ${err}`);
                    lastCount = client.mailbox.exists;
                    console.error(`Continuing to watch INBOX despite error (${lastCount} messages)...`);
                }
                finally {
                    lastCount = client.mailbox.exists;
                }
            } else {
                console.log("No new messages found.");
            }
        }

        console.log("Watching for new messages...");
        client.on('exists', async (data) => {
            if (data.count > lastCount) {
                try {
                    await handleNewMessages(client, lastCount);
                } finally {
                    lastCount = data.count;
                }
            }
        });

        await new Promise(resolve => {
            client.once("close", resolve);
        });

        console.log(new Date().toISOString(), "IMAP connection closed.");
        lock.release();
    } catch (err) {
        console.error(new Date().toISOString(), "IMAP error:", err);
    }

    if (!shuttingDown) {
        console.log("Reconnecting in 5 seconds...");
        await sleep(5_000);
    }
}

async function handleNewMessages(client, lastCount) {
    let newMessages = await client.fetchAll(
        `${lastCount + 1}:*`,
        {
            envelope: true,
            bodyStructure: true,
        }
    );
    for (let msg of newMessages) {
        console.log(`New email: '${msg.envelope.subject}'`);
        const fromAddresses = msg.envelope.from.map(x => x.address);
        if (!(fromAddresses.some(a => a == process.env.TARGET_SENDER) || process.env.DEBUG_MODE && fromAddresses.some(a => a == process.env.DEBUG_SENDER))) {
            console.log("Not the sender we're looking for");
            continue;
        }
        console.log("Sender correct!");

        let attachments = findAttachments(msg.bodyStructure);
        let filteredAttachments = attachments.filter(a => a.filename !== "unnamed");

        if (filteredAttachments.length <= 0) {
            console.log("No attachments");
            continue;
        }

        const attachment = filteredAttachments[0];
        console.log("Attachment found: " + attachment.filename);

        const pdfBuffer = await downloadAttachment(client, msg.uid, attachment.part).catch(console.error);
        console.log("Downloaded attachment");

        const shifts = await extractShiftsFromPdf(pdfBuffer, attachment.filename);
        console.log("Shifts found:");
        console.log(shifts);
        console.log("Creating events:");
        for (let shift of shifts) {
            await createCalendarEvent(shift, auth);
        }
    }
    console.log(`Continuing to watch INBOX (${lastCount} messages)...`);
}
