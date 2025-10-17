using {sap.tisce.demo as db} from '../db/schema';

service ChatService @(requires: 'authenticated-user') {

    entity Conversation @(restrict: [{
        grant: ['READ','WRITE', 'DELETE'],
        where: 'userID = $user'
    }])                 as projection on db.Conversation;
    entity Message          as projection on db.Message;
   entity MessageFeedBk      as projection on db.MessageFeedBk;

        @readonly
    entity CMF as
    select from Message as M
    left outer join MessageFeedBk       as F on M.mID = F.mID    // <-- note the .cID after the association
    {
      key M.mID         as mID,
      key F.fID         as fID,
      M.role,
      M.content,
      M.creation_time   as QUERY_AT,
      F.consent_flag,
      F.feedback_score,
      F.feedback,
      F.created_at      as FEEDBACK_AT,
      F.created_by      as FEEDBACK_BY
  };


    type RagResponse_AdditionalContents {

        score       : String;
        pageContent : String;
    }

    type RagResponse {
        role               : String;
        content            : String;
        messageTime        : String;
        messageId          : String;
        additionalContents : array of RagResponse_AdditionalContents;
    }

    action   getChatRagResponse(conversationId : String, messageId : String, message_time : Timestamp, user_id : String, user_query : String) returns RagResponse;
    function deleteChatData() returns String;
}
