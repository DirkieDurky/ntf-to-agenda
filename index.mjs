import { findAttachments, downloadAttachment } from "./mailHelpers.mjs";
import { extractAllShiftsFromPdf } from "./parsePdf.mjs";
import * as googleCalendar from "./googleCalendar.mjs";
import { ImapFlow } from 'imapflow';
import { sleep, formatDate, formatDateTime } from "./helpers.mjs";
import config from './config.json' with { type: 'json' };
import _ from 'lodash';

const imapConfig = {
    host: config.emailHost,
    port: config.emailPort,
    secure: true,
    auth: {
        user: config.emailUsername,
        pass: config.emailPassword
    },
    logger: false,
}

console.log(formatDate(new Date()), "|", "Authorizing to Google Calendar API...");
const calendarApi = await googleCalendar.authorizeGoogleAPI();

let shuttingDown = false;
let lastKnownUid = null;
let client;
let lock;
while (!shuttingDown) {
    try {
        client = new ImapFlow(imapConfig);

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
                console.error("Something went wrong handling a message:", err);
            }
        }

        console.log(formatDate(new Date()), "|", "Watching for new messages...");
        client.on('exists', async () => {
            try {
                await handleNewMessages(client);
            } catch (err) {
                console.error("Something went wrong handling a message:", err);
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
        console.log(formatDate(new Date()), "|", `New email: '${msg.envelope.subject ?? "Unknown subject"}' (${msg.uid})`);
        const fromAddresses = msg.envelope.from.map(x => x.address);
        if (!(fromAddresses.some(a => a == config.targetSender) || config.debugMode && fromAddresses.some(a => a == config.debugSender))) {
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

        const shifts = await extractAllShiftsFromPdf(pdfBuffer, attachment.filename);

        // Prepare descriptions for each day
        const descriptions = new Map();
        for (let [date, shiftsThisDay] of shifts.byDate) {
            shiftsThisDay = _.orderBy(shiftsThisDay, [s => s.employeeName === "Open", 'startDateTime', 'endDateTime', 'employeeName'], ['asc', 'asc', 'asc', 'asc']);
            const types = _.uniqBy(shiftsThisDay, 'type').map(s => s.type).sort();
            let description = "";
            let shiftLists = [];
            for (const type of types) {
                let shiftList = "";
                shiftList += type + ":\n";
                let shiftsOfThisType = shiftsThisDay.filter(s => s.type === type);
                shiftsOfThisType = shiftsOfThisType.map(s =>
                    // s.employeeName + Array(1 + Math.floor((longestNameLength - s.employeeName.length) / 32) + 1).join("	") + formatDateTime(s.startDateTime) + "-" + formatDateTime(s.endDateTime)
                    // `<tr><td>${s.employeeName}</td><td>${formatDateTime(s.startDateTime)} - ${formatDateTime(s.endDateTime)}</td></tr>`
                    // s.employeeName + Array(1 + longestNameLength - s.employeeName.length + 4).join(" ") + formatDateTime(s.startDateTime) + "-" + formatDateTime(s.endDateTime)
                    // formatDateTime(s.startDateTime) + "-" + formatDateTime(s.endDateTime) + "  |  " + s.employeeName
                    `<tr><td>${formatDateTime(s.startDateTime)} - ${formatDateTime(s.endDateTime)}</td><td> ...   ${s.employeeName}</td></tr>`
                );
                shiftList += "<table>" + shiftsOfThisType.join("\n") + "</table>";
                shiftLists.push(shiftList);
            }
            description += shiftLists.join("\n\n");
            descriptions.set(date, description);
        }

        const weekRangeRegex = /Weekplanning \((\d{2}-\d{2}-\d{4})-(\d{2}-\d{2}-\d{4})\).pdf/;
        const matches = attachment.filename.match(weekRangeRegex);
        const startDate = new Date(matches[1].replace(/(\d{2})-(\d{2})-(\d{4})/, '$2-$1-$3'));
        const endDate = new Date(matches[2].replace(/(\d{2})-(\d{2})-(\d{4})/, '$2-$1-$3'));
        // Add one day because this is the upper bound for the range.
        // By adding 1 day we ensure the last day is included in the range.
        endDate.setDate(endDate.getDate() + 1);

        // Updating global calendar
        console.log();
        console.log(formatDate(new Date()), "|", `Updating global calendar`);
        console.log(formatDate(new Date()), "|", `Clearing week from ${formatDate(startDate)} to ${formatDate(endDate)}...`);
        await googleCalendar.clearWeek(calendarApi, config.globalCalendarId, startDate, endDate);
        console.log(formatDate(new Date()), "|", "Creating events...");
        for (const [date, shiftsThisDay] of shifts.byDate ?? []) {
            let firstShiftStart = null;
            let lastShiftEnd = null;
            for (const shift of shiftsThisDay) {
                if (firstShiftStart === null || shift.startDateTime < firstShiftStart) {
                    firstShiftStart = shift.startDateTime;
                }
                if (lastShiftEnd === null || shift.endDateTime > lastShiftEnd) {
                    lastShiftEnd = shift.endDateTime;
                }
            }

            await googleCalendar.createEvent(calendarApi, config.globalCalendarId, firstShiftStart, lastShiftEnd, "Kwalitaria", descriptions.get(date));
        }

        // Updating target specific calendars
        for (const target of config.targets) {
            console.log();
            console.log(formatDate(new Date()), "|", `Updating calendar for ${target.name}`);
            console.log(formatDate(new Date()), "|", `Clearing week from ${formatDate(startDate)} to ${formatDate(endDate)}...`);
            await googleCalendar.clearWeek(calendarApi, target.calendarId, startDate, endDate);

            console.log(formatDate(new Date()), "|", "Creating events...");

            for (let shift of shifts.byEmployee.get(target.name) ?? []) {
                let summary = `Kwalitaria - ${shift.type}`;

                if (shift.type === "Bezorgen") {
                    let deliveryLengthInfo;
                    if (formatDateTime(shift.startDateTime) === "16:30" && formatDateTime(shift.endDateTime) === "20:30") {
                        deliveryLengthInfo = "Lange shift";
                    }
                    else if (formatDateTime(shift.startDateTime) === "17:00" && formatDateTime(shift.endDateTime) === "20:00") {
                        deliveryLengthInfo = "Korte shift";
                    }
                    else {
                        deliveryLengthInfo = "Speciale shift";
                    }
                    summary += ` - ${deliveryLengthInfo}`;

                    let companionshipInfo;
                    const otherDeliverers = shifts.byDate.get(shift.date).filter(s => s.type === "Bezorgen" && s.employeeName !== target.name);
                    if (otherDeliverers.length > 0) {
                        companionshipInfo = "Met " + otherDeliverers.map(s => s.employeeName).join(" en ");
                    } else {
                        companionshipInfo = "Alleen";
                    }
                    summary += ` - ${companionshipInfo}`;
                }
                await googleCalendar.createEvent(calendarApi, target.calendarId, shift.startDateTime, shift.endDateTime, summary, descriptions.get(shift.date));
            }
        }
    }
    console.log(formatDate(new Date()), "|", `Continuing to watch INBOX...`);
}
