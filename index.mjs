import { findAttachments } from "./mail.mjs";
import { extractShiftsFromPdf } from "./parsePdf.mjs";
import { googleCalendarAuthorize, createCalendarEvent } from "./googleCalendar.mjs";
import { ImapFlow } from 'imapflow';
import { sleep, timeout } from "./helpers.mjs";
import 'dotenv/config';

// console.log("Authorizing to Google Calendar API...");
// const auth = await googleCalendarAuthorize();

let client;
let lastCount = null;
async function connectImap() {
    let shuttingDown;

    while (true) {
        try {
            client = new ImapFlow({
                host: process.env.EMAIL_HOST,
                port: process.env.EMAIL_PORT,
                secure: true,
                auth: {
                    user: process.env.EMAIL_USERNAME,
                    pass: process.env.EMAIL_PASSWORD
                },
                logger: false,
                socketTimeout: 35000,
            });

            console.log(new Date().toISOString(), "Attempting connection...");
            await client.connect();
            console.log(new Date().toISOString(), "IMAP connected");
            break;
        } catch (err) {
            console.error(
                new Date().toISOString(),
                "Reconnect failed:",
                err.code || err.message
            );
            console.error(new Date().toISOString(), "Trying again in 5 seconds...");
            await sleep(5_000);
        }
    }

    async function shutdown() {
        console.log(new Date().toISOString(), "Shutting down...");
        shuttingDown = true;
        try {
            await timeout(client.logout(), 1000);
        } catch { }
        lock.release();

        process.exit(0);
    }

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    client.on("error", err => {
        console.error(new Date().toISOString(), "IMAP error:", err);
        console.error(`Continuing to watch INBOX despite error (${lastCount} messages)...`);
    });

    client.on("close", async () => {
        if (!shuttingDown) {
            console.log(new Date().toISOString(), "IMAP closed, reconnecting...");
            connectImap();
        }
    });

    let lock = await client.getMailboxLock('INBOX');
    try {
        if (lastCount == null) lastCount = client.mailbox.exists;
        console.log(`Watching INBOX (${lastCount} messages)...`);

        async function handleNewMessages() {
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

                const pdfBuffer = await downloadAttachment(msg.uid, attachment.part).catch(console.error);
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

        // Check for any missed mails since last connection
        console.log("Checking for new messages since last connection...");
        console.log(`Last known amount of messages in INBOX: ${lastCount}`);
        console.log(`Current amount of messages in INBOX: ${client.mailbox.exists}`);
        if (client.mailbox.exists > lastCount) {
            console.log("New message(s) found");
            try {
                await handleNewMessages();
            } catch (err) {
                console.log(`Error while handling new messages: ${err}`);
                lastCount = client.mailbox.exists;
                console.error(`Continuing to watch INBOX despite error (${lastCount} messages)...`);
            }
            finally {
                lastCount = client.mailbox.exists;
            }
        } else {
            console.log("No new messages found");
        }

        client.on('exists', async (data) => {
            if (data.count > lastCount) {
                try {
                    await handleNewMessages();
                } finally {
                    lastCount = data.count;
                }
            }
        });

        await new Promise(resolve => process.on('SIGINT', resolve));
    } finally {
        lock.release();
        await client.logout();
    }
}

async function downloadAttachment(messageUid, attachmentPart) {
    let lock = await client.getMailboxLock('INBOX');
    try {
        const { content } = await client.download(messageUid, attachmentPart, { uid: true });

        const chunks = [];
        for await (const chunk of content) {
            chunks.push(chunk);
        }

        const pdfBuffer = Buffer.concat(chunks);
        return pdfBuffer;
    } finally {
        lock.release();
    }
}

connectImap();
