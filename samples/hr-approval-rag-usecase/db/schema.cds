namespace sap.tisce.demo;

using {
    cuid,
    managed
} from '@sap/cds/common';

entity Conversation {

    key cID : UUID not null;
    userID: String;
    creation_time: Timestamp;
    last_update_time: Timestamp;
    title: String;
    to_messages: Composition of many Message on to_messages.cID = $self;
}

entity Message {

    key cID: Association to Conversation;
    key mID: UUID not null;
    role: String;
    content: LargeString;
    creation_time: Timestamp;
}

entity MessageFeedBk {
    key fID: UUID not null @Core.Computed : true;
    key mID: UUID not null;
    consent_flag :String(1);
    feedback_score: String(2);
    feedback: LargeString;
    created_at: Timestamp default $now
                      @cds.on.insert : $now;
    created_by : String;
}

entity DocumentChunk
{
    text_chunk: LargeString;
    metadata_column: LargeString;
    embedding: Vector(1536);
}


entity Files: cuid, managed{
    @Core.MediaType: mediaType @Core.ContentDisposition.Filename: fileName
    content: LargeBinary;
    @Core.IsMediaType: true
    mediaType: String;
    fileName: String;
    size: String;
}

