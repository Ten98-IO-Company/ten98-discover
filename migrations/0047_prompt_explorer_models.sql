ALTER TABLE prompt_execution DROP CONSTRAINT prompt_execution_position_check;
ALTER TABLE prompt_execution ADD CONSTRAINT prompt_execution_position_check CHECK(position IN(0,1,2,3));
